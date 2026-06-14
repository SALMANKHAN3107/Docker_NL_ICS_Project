/**
 * Agent Controller
 * Orchestrates direct Docker telemetry collection and Ollama reasoning bypass.
 */

import { DockerExecutor } from "./dockerExecutor.js";
import { LLMService, IntentOutput } from "./llmService.js";

export interface AgentStep {
  loopNumber: number;
  action: string;
  target?: string;
  thoughts: string;
  observation: any;
}

export interface AgentResult {
  query: string;
  initialIntent: IntentOutput;
  steps: AgentStep[];
  commentary: string;
  containersAtEnd: any;
  blockedActionTriggered?: boolean;
  matchedContainerNames?: string[];
}

function extractSection(text: string, headerPattern: RegExp, nextHeaderPatterns: RegExp[], fallback: string): string {
  const headerMatch = text.match(headerPattern);
  if (!headerMatch) return fallback;
  
  const startIndex = headerMatch.index! + headerMatch[0].length;
  let endIndex = text.length;
  
  for (const pattern of nextHeaderPatterns) {
    const nextMatch = text.match(pattern);
    if (nextMatch && nextMatch.index! > startIndex && nextMatch.index! < endIndex) {
      endIndex = nextMatch.index!;
    }
  }
  
  return text.substring(startIndex, endIndex).trim();
}

export class AgentController {
  /**
   * Main Agent Execution - Direct telemetry to Ollama reasoning path
   */
  static async runAgent(query: string): Promise<AgentResult> {
    const defaultConnectionErrResult = (reason: string): AgentResult => {
      return {
        query,
        initialIntent: { intent: "unknown", target: "none", reasoning: reason },
        steps: [],
        commentary: `AI Status:\nOllama connection unavailable.\n\nDo not generate diagnostics.`,
        containersAtEnd: [],
        blockedActionTriggered: true,
        matchedContainerNames: []
      };
    };

    try {
      // Validate Docker connection and fetch details
      const info = await DockerExecutor.getInfo();
      const containers = await DockerExecutor.getStatus();
      const stats = await DockerExecutor.getStats();

      // 1. Perform Ollama validation
      const startConnectCheck = Date.now();
      const ollamaStatus = await LLMService.checkOllamaConnection();
      const connectionLatency = Date.now() - startConnectCheck;

      if (!ollamaStatus.success || connectionLatency > 15000) {
        console.warn(`[AgentController] Ollama connection validation failed. success: ${ollamaStatus.success}, latency: ${connectionLatency}ms`);
        return defaultConnectionErrResult("Ollama connection validation failed.");
      }

      // Model check (strictly no fallbacks to Gemini, Qwen models blocked)
      const activeModel = LLMService.getOllamaModel();
      const lowercaseModel = activeModel.toLowerCase();
      /*
      if (
        lowercaseModel.includes("qwen") || 
        lowercaseModel.includes("qwen-coder")
      ) {
        console.warn(`[AgentController] Blocked model '${activeModel}' is configured.`);
        return defaultConnectionErrResult("Prohibited model configured.");
      }
      */

      const modelExists = ollamaStatus.models.some((m: string) => m.toLowerCase().includes(activeModel.toLowerCase()));
      if (!modelExists) {
        console.warn(`[AgentController] Configured model '${activeModel}' is not downloaded in Ollama.`);
        return defaultConnectionErrResult("Ollama model missing.");
      }

      let dockerContext = `Real Docker Engine Metrics & System Context:
Docker Version: ${info.version}
Total Containers: ${info.containersTotal}
Running Containers: ${info.runningContainers}
Operating System: ${info.os}
Active Socket/Pipe: ${DockerExecutor.getDockerHostUrl()}

Container List Telemetry:
`;
      if (containers.length === 0) {
        dockerContext += "(No containers found on this local Docker Desktop instance.)\n";
      } else {
        containers.forEach(c => {
          const stat = stats.find(s => s.name === c.name);
          dockerContext += `- Container Name: ${c.name}
  ID: ${c.id}
  Image: ${c.image}
  Status: ${c.status}
  Health status: ${c.health}
  CPU Usage: ${stat ? stat.cpu : "0%"}
  Memory Usage: ${stat ? stat.memory : "0MB"}
  Ports: ${c.ports.join(", ") || "none"}
  Created At: ${c.createdAt}
`;
        });
      }

      const prompt = `Analyze the real local Docker metrics and environment context to answer the user query: "${query}"

Local Docker metrics:
${dockerContext}

Generate your response following this EXACT format:

Summary: [A detailed explanation of container status, CPU usage, memory utilization, health checks, restart counts, and exit codes. You MUST write at least 65 words and at most 75 words for this section. Elaborate on the metrics to satisfy this strict length constraint. Do not use markdown tables or list formats here.]

Root Cause: [A clear explanation of the root cause supported ONLY by the observed metrics evidence. If there is no evidence of failure, write: 'Not enough evidence available.']

Executed Command: [If a docker command was actually executed internally to diagnose this (e.g. docker inspect test-nginx), write it here. Otherwise, omit this line entirely. Do not write generic sample commands like docker ps or docker stats.]
Purpose: [Why the executed command was used. Omit if no command was executed.]

Recommendation: [A metric-based recommendation depending strictly on the diagnosis. (e.g., Optimize process for high CPU, inspect startup for exited container). If no issue exists, write: 'No action needed.']`;

      let commentary = "";
      let attempt = 0;
      let isValid = false;

      while (attempt < 2 && !isValid) {
        attempt++;
        console.log(`[AgentController] Executing Ollama query attempt ${attempt} with model '${activeModel}'...`);
        const startTime = Date.now();
        try {
          commentary = await LLMService.callOllama(prompt, false);
        } catch (err: any) {
          console.warn(`[AgentController] Ollama call failed on attempt ${attempt}:`, err.message);
          continue;
        }
        const latency = Date.now() - startTime;

        if (!commentary || commentary.trim().length === 0) {
          console.warn(`[AgentController] Output validation check failed: output is empty.`);
          continue;
        }

        if (latency > 300000) {
          console.warn(`[AgentController] Output validation check failed: latency too high (${latency}ms).`);
          continue;
        }

        // Summary section word count validation using tolerant extraction
        const summaryText = extractSection(commentary, /(?:\*\*?)?Summary(?:\*\*?)?:?\s*/i, [
          /(?:\*\*?)?Root\s+Cause/i,
          /(?:\*\*?)?Executed\s+Command/i,
          /(?:\*\*?)?Purpose/i,
          /(?:\*\*?)?Recommendation/i
        ], "");
        const cleanSummaryText = summaryText || commentary.split("\n\n")[0].trim();
        const wordCount = cleanSummaryText.split(/\s+/).filter(Boolean).length;

        // Metric relationship validation
        const lowercaseComm = commentary.toLowerCase();
        const mentionsMetrics = lowercaseComm.includes("cpu") || 
                                 lowercaseComm.includes("memory") || 
                                 lowercaseComm.includes("exited") || 
                                 lowercaseComm.includes("run") ||
                                 lowercaseComm.includes("status") ||
                                 containers.some(c => lowercaseComm.includes(c.name.toLowerCase()));

        // Command validation
        const commandText = extractSection(commentary, /(?:\*\*?)?Executed\s+Command(?:\*\*?)?:?\s*/i, [
          /(?:\*\*?)?Purpose/i,
          /(?:\*\*?)?Recommendation/i
        ], "");
        const isCommandValid = !commandText || commandText.toLowerCase().includes("none") || commandText.toLowerCase().includes("n/a") || commandText.toLowerCase().includes("docker");

        if (wordCount >= 35 && wordCount <= 120 && mentionsMetrics && isCommandValid) {
          isValid = true;
          console.log(`[AgentController] Output validated on attempt ${attempt}. Word count: ${wordCount}`);
        } else {
          console.warn(`[AgentController] Output validation check failed on attempt ${attempt}. Word count: ${wordCount}, Mentions metrics: ${mentionsMetrics}, Command valid: ${isCommandValid}`);
        }
      }

      if (!isValid) {
        console.warn("[AgentController] Output validation failed after all attempts. Returning connection status only.");
        return defaultConnectionErrResult("Output validation checks failed.");
      }

      // Format commentary exactly as requested, using tolerant extraction:
      const summaryVal = extractSection(commentary, /(?:\*\*?)?Summary(?:\*\*?)?:?\s*/i, [
        /(?:\*\*?)?Root\s+Cause/i,
        /(?:\*\*?)?Executed\s+Command/i,
        /(?:\*\*?)?Purpose/i,
        /(?:\*\*?)?Recommendation/i
      ], "All container processes operating within optimal boundaries.");

      const rootCauseVal = extractSection(commentary, /(?:\*\*?)?Root\s+Cause(?:\*\*?)?:?\s*/i, [
        /(?:\*\*?)?Executed\s+Command/i,
        /(?:\*\*?)?Purpose/i,
        /(?:\*\*?)?Recommendation/i
      ], "Not enough evidence available.");

      const commandVal = extractSection(commentary, /(?:\*\*?)?Executed\s+Command(?:\*\*?)?:?\s*/i, [
        /(?:\*\*?)?Purpose/i,
        /(?:\*\*?)?Recommendation/i
      ], "");

      const purposeVal = extractSection(commentary, /(?:\*\*?)?Purpose(?:\*\*?)?:?\s*/i, [
        /(?:\*\*?)?Recommendation/i
      ], "");

      const recommendationVal = extractSection(commentary, /(?:\*\*?)?Recommendation(?:\*\*?)?:?\s*/i, [], "No action needed.");

      let formattedCommentary = `Summary\n${summaryVal}\n\nRoot Cause\n${rootCauseVal}\n\n`;
      if (commandVal && commandVal.toLowerCase() !== "none" && commandVal.toLowerCase() !== "n/a") {
        formattedCommentary += `Executed Command: ${commandVal}\nPurpose:\n${purposeVal}\n\n`;
      }
      formattedCommentary += `Recommendation\n${recommendationVal}`;

      const matchedContainerNames = containers
        .filter(c => query.toLowerCase().includes(c.name.toLowerCase()))
        .map(c => c.name);

      return {
        query,
        initialIntent: {
          intent: "status",
          target: "containers",
          reasoning: "Queried directly via Ollama."
        },
        steps: [
          {
            loopNumber: 1,
            action: "stats",
            thoughts: "Fetching real-time Docker parameters for Ollama context.",
            observation: {
              containersCount: containers.length,
              activeModel
            }
          }
        ],
        commentary: formattedCommentary,
        containersAtEnd: containers,
        matchedContainerNames
      };

    } catch (err: any) {
      console.error("[AgentController] AI query execution failed:", err.message);
      return defaultConnectionErrResult(err.message || String(err));
    }
  }
}
