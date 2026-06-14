/**
 * LLM Service with dual-support for Google Gemini (Cloud) and Local/Cloud Ollama.
 * Locked strictly to local Ollama per project guidelines.
 */

import dotenv from "dotenv";
import { DockerExecutor } from "./dockerExecutor.js";

dotenv.config();

export interface IntentOutput {
  intent: 'action' | 'retrieval' | 'logs' | 'reasoning' | 'unknown';
  target: string;
  containerName?: string;
  action?: 'start' | 'stop' | 'restart' | 'none';
  filter?: 'running' | 'exited' | 'none';
  reasoning: string;
}

export class LLMService {
  private static ollamaUrl: string = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  private static ollamaModel: string = process.env.OLLAMA_MODEL || "llama3:latest";
  private static activeProvider: 'ollama' = 'ollama';

  static getOllamaUrl(): string {
    return this.ollamaUrl;
  }

  static getOllamaModel(): string {
    return this.ollamaModel;
  }

  static getActiveProvider(): 'ollama' {
    return 'ollama';
  }

  static setOllamaUrl(url: string) {
    this.ollamaUrl = url;
  }

  static setOllamaModel(model: string) {
    this.ollamaModel = model;
  }

  static setActiveProvider(provider: 'gemini' | 'ollama') {
    // Strictly locked to ollama
    this.activeProvider = 'ollama';
  }

  static async checkOllamaConnection(): Promise<{ success: boolean; models: string[]; error?: string }> {
    const timeoutMs = 4000;
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(id);

      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }

      const data = await response.json();
      const modelNames = (data.models || []).map((m: any) => m.name);
      return { success: true, models: modelNames };
    } catch (err: any) {
      return { success: false, models: [], error: err.message || String(err) };
    }
  }

  private static async isLLMAvailable(): Promise<boolean> {
    return true; // Ollama is mandatory
  }

  private static recordLLMError(err: any) {
    const errMsg = err?.message || String(err);
    console.warn(`[Ollama] Service communication error: ${errMsg}`);
  }

  private static cleanOllamaResponse(text: string): string {
    let cleaned = text.trim();
    // Strip DeepSeek-R1 <think> blocks
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
    cleaned = cleaned.trim();

    // Extract first valid JSON block
    const firstIndex = cleaned.indexOf("{");
    const lastIndex = cleaned.lastIndexOf("}");
    if (firstIndex !== -1 && lastIndex !== -1 && lastIndex > firstIndex) {
      cleaned = cleaned.substring(firstIndex, lastIndex + 1);
    }
    return cleaned;
  }

  public static async callOllama(prompt: string, jsonMode: boolean = false): Promise<string> {
    const url = `${this.ollamaUrl}/api/generate`;
    const timeoutMs = 300000; // 300 seconds timeout

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[LLMService] Call Ollama to ${url}...`);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          stream: false,
          format: jsonMode ? "json" : undefined
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from Ollama: ${response.statusText}`);
      }

      const data = await response.json();
      return data.response || "";
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn(`[LLMService] Ollama call failed: ${err.message || err}`);
      throw err;
    }
  }

  /**
   * Phase 1: Translate user query to structured intent
   */
  static async translate(userInput: string): Promise<IntentOutput> {
    let activeNames: string[] = [];
    try {
      const activeStatus = await DockerExecutor.getStatus();
      activeNames = activeStatus.map(c => c.name);
    } catch (e) {
      console.warn("[LLM translate] Failed to get docker container status: ", e);
    }

    const activeNamesStr = activeNames.length > 0 ? activeNames.map(n => `"${n}"`).join(", ") : "none";

    const prompt = `Analyze the user query: "${userInput}"
    Matched against the active container list: [${activeNamesStr}].

    Classify the query into one of these 4 intent types:
    1. "action" (mutating actions like starting, stopping, restarting a container)
       - Examples: "start nginx", "stop backend", "restart redis"
    2. "retrieval" (fetching list, counts, stats, or general tables of containers)
       - Examples: "show running containers", "show exited containers", "how many containers", "show memory usage"
    3. "logs" (fetching logs for a specific container, explaining logs, or diagnosing failures through logs)
       - Examples: "show logs of nginx", "explain logs", "why container failed"
    4. "reasoning" (analyzing CPU anomalies, resource metrics, or recommendations)
       - Examples: "why cpu high", "recommend improvements"

    Return a JSON object with this exact shape:
    {
      "intent": "action" | "retrieval" | "logs" | "reasoning",
      "target": "the target subject, e.g. nginx or exited containers",
      "containerName": "the exact matched container name from [${activeNamesStr}] if any, or 'none'",
      "action": "start" | "stop" | "restart" | "none",
      "filter": "running" | "exited" | "none",
      "reasoning": "brief explanation of classification"
    }

    Respond ONLY with the raw JSON object. No explanation, no markdown backticks, no thinking blocks.`;

    try {
      const responseText = await this.callOllama(prompt, true);
      const cleaned = this.cleanOllamaResponse(responseText);
      const parsed = JSON.parse(cleaned);

      return {
        intent: parsed.intent || 'unknown',
        target: parsed.target || 'containers',
        containerName: parsed.containerName === 'none' ? undefined : parsed.containerName,
        action: parsed.action || 'none',
        filter: parsed.filter || 'none',
        reasoning: parsed.reasoning || 'Ollama parsed intent.'
      };
    } catch (error: any) {
      this.recordLLMError(error);
      throw new Error(`Ollama parsing failed: ${error.message || error}`);
    }
  }

  /**
   * Type 1: Explain Action Outcome
   */
  static async explainActionResult(action: string, containerName: string, result: any): Promise<string> {
    const prompt = `The user requested to perform the action "${action}" on container "${containerName}".
    The execution result from the Docker daemon is:
    ${JSON.stringify(result, null, 2)}

    Generate a brief, clear explanation of the action outcome. State if the action was successful.
    
    Follow these rules strictly:
    1. Target response length: Write a response between 60 and 120 words. Plan your length before generation to fit naturally within this range.
    2. Every response must contain complete thoughts and complete sentences. Finish naturally and end correctly with a standard punctuation mark (. or ! or ?).
    3. Do NOT use ellipsis, trailing dots ("..."), unfinished lines, or partial sentences. No abrupt stopping.
    4. Stay focused and answer only the query. Avoid repetition, filler, extra explanation, or generic statements.`;

    try {
      return await this.callOllama(prompt, false);
    } catch (error: any) {
      this.recordLLMError(error);
      throw error;
    }
  }

  /**
   * Type 2: Generate Retrieval Summary (60 to 120 words)
   */
  static async generateRetrievalSummary(containers: any[]): Promise<string> {
    const prompt = `Synthesize a concise status summary of the following containers:
    ${JSON.stringify(containers, null, 2)}

    Follow these rules strictly:
    1. Target response length: Write a response between 60 and 120 words. Plan your length before generation to fit naturally within this range.
    2. Every response must contain complete thoughts and complete sentences. Finish naturally and end correctly with a standard punctuation mark (. or ! or ?).
    3. Do NOT use ellipsis, trailing dots ("..."), unfinished lines, or partial sentences. No abrupt stopping.
    4. Mention specific container names, their status (e.g. running, exited), and metrics (CPU and Memory).
    5. Do NOT mention health check, health status, or health metrics.
    6. Do NOT repeat any phrases, words, or facts.
    7. Do NOT use markdown tables, list formats, or section headers. Output plain text only.`;

    try {
      return await this.callOllama(prompt, false);
    } catch (error: any) {
      this.recordLLMError(error);
      throw error;
    }
  }

  /**
   * Type 3: Explain Logs
   */
  static async explainLogs(containerName: string, logs: string[]): Promise<string> {
    const logsSnippet = logs.slice(-30).join("\n");
    const prompt = `Explain the recent logs for container "${containerName}":
    ${logsSnippet}

    Follow these rules strictly:
    1. Target response length: Write a response between 60 and 120 words. Plan your length before generation to fit naturally within this range.
    2. Every response must contain complete thoughts and complete sentences. Finish naturally and end correctly with a standard punctuation mark (. or ! or ?).
    3. Do NOT use ellipsis, trailing dots ("..."), unfinished lines, or partial sentences. No abrupt stopping.
    4. Provide a clear explanation of what the logs indicate and identify if there are any error messages or exceptions.
    5. Stay focused and answer only the query. Avoid repetition, filler, or generic statements.`;

    try {
      return await this.callOllama(prompt, false);
    } catch (error: any) {
      this.recordLLMError(error);
      throw error;
    }
  }

  /**
   * Type 4: Generate Reasoning Summary (60 to 120 words)
   */
  static async generateReasoningSummary(query: string, containers: any[]): Promise<string> {
    const prompt = `Analyze the user query: "${query}"
    Based on the following container states and metrics:
    ${JSON.stringify(containers, null, 2)}

    Follow these rules strictly:
    1. Target response length: Write a response between 60 and 120 words. Plan your length before generation to fit naturally within this range.
    2. Every response must contain complete thoughts and complete sentences. Finish naturally and end correctly with a standard punctuation mark (. or ! or ?).
    3. Do NOT use ellipsis, trailing dots ("..."), unfinished lines, or partial sentences. No abrupt stopping.
    4. Conduct reasoning and diagnosis to answer the user query.
    5. Highlight any metric anomalies (like high CPU or memory pressure). Never mention health check or health status.
    6. Mention container names, status, and metrics.
    7. Do not repeat words or sentences.`;

    try {
      return await this.callOllama(prompt, false);
    } catch (error: any) {
      this.recordLLMError(error);
      throw error;
    }
  }
}
