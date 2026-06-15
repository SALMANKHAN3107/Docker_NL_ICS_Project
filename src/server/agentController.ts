/**
 * Agent Controller
 * Orchestrates Docker operations based on structured Ollama parsing.
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

export function classifyContainerHealth(c: any): 'healthy' | 'unhealthy' {
  const status = (c.status || '').toLowerCase();
  const health = (c.health || '').toLowerCase();
  const restartCount = c.restartCount || 0;
  
  let cpuVal = 0;
  if (typeof c.cpu === 'string') {
    cpuVal = parseFloat(c.cpu.replace('%', '')) || 0;
  } else if (typeof c.cpu === 'number') {
    cpuVal = c.cpu;
  }
  
  let memPercent = 0;
  if (typeof c.memoryUsagePercentage === 'string') {
    memPercent = parseFloat(c.memoryUsagePercentage.replace('%', '')) || 0;
  } else if (c.memory && c.memoryLimit) {
    memPercent = (c.memory / c.memoryLimit) * 100;
  } else if (typeof c.memory === 'string') {
    const parts = c.memory.split('/');
    if (parts.length === 2) {
      const usage = parseFloat(parts[0].replace(/[^\d.]/g, '')) || 0;
      const limit = parseFloat(parts[1].replace(/[^\d.]/g, '')) || 0;
      if (limit > 0) memPercent = (usage / limit) * 100;
    }
  }

  // Healthy if status is running, no restart loop, normal CPU/Memory (<= 90%), and not unhealthy
  const isUnhealthy = 
    status.includes('exit') || 
    status.includes('stop') ||
    status.includes('restart') || 
    status.includes('dead') || 
    status.includes('pause') ||
    health === 'unhealthy' ||
    restartCount > 2 ||
    cpuVal > 90 || 
    memPercent > 90;

  return isUnhealthy ? 'unhealthy' : 'healthy';
}

export class AgentController {
  // Simple static storage for mutating action confirmations
  private static pendingAction: { action: 'start' | 'stop' | 'restart'; containerName: string } | null = null;

  /**
   * Main Agent Execution
   */
  static async runAgent(query: string): Promise<AgentResult> {
    const defaultErrorResult = (reason: string): AgentResult => {
      return {
        query,
        initialIntent: { intent: "unknown", target: "none", reasoning: reason },
        steps: [],
        commentary: `AI Status:\nOllama query orchestration failed: ${reason}`,
        containersAtEnd: []
      };
    };

    try {
      // 1. Perform Ollama validation
      const ollamaStatus = await LLMService.checkOllamaConnection();
      if (!ollamaStatus.success) {
        return defaultErrorResult("Local Ollama connection failed. Ensure 'ollama serve' is running.");
      }

      const activeModel = LLMService.getOllamaModel();
      const modelExists = ollamaStatus.models.some((m: string) => m.toLowerCase().includes(activeModel.toLowerCase()));
      if (!modelExists) {
        return defaultErrorResult(`Configured Ollama model '${activeModel}' is not downloaded.`);
      }

      const containers = await DockerExecutor.getStatus();
      const unhealthyContainers = containers.filter(c => classifyContainerHealth(c) === 'unhealthy');
      const healthyContainers = containers.filter(c => classifyContainerHealth(c) === 'healthy');

      const lowerQuery = query.trim().toLowerCase();
      const isQueryingUnhealthy = lowerQuery.includes("unhealthy") || lowerQuery.includes("failed") || lowerQuery.includes("non-running") || lowerQuery.includes("exited") || lowerQuery.includes("stopped");
      const isQueryingHealthy = lowerQuery.includes("healthy") || lowerQuery.includes("running");

      // Rule: If no unhealthy containers, directly return static summary
      if (isQueryingUnhealthy && unhealthyContainers.length === 0) {
        return {
          query,
          initialIntent: { intent: "reasoning", target: "unhealthy containers", reasoning: "Environment clean: no unhealthy containers detected." },
          steps: [
            {
              loopNumber: 1,
              action: "stats",
              thoughts: "Inspecting host system and container list for issues.",
              observation: { count: 0 }
            }
          ],
          commentary: "No unhealthy containers detected with ai summary. All active containers appear stable.",
          containersAtEnd: []
        };
      }

      const isConfirmation = ["yes", "proceed", "confirm", "y", "go ahead"].includes(lowerQuery);

      // Check if we have a pending action and the user is confirming it
      if (isConfirmation && this.pendingAction) {
        const { action, containerName } = this.pendingAction;

        console.log(`[AgentController] Executing confirmed action '${action}' on container '${containerName}'...`);
        const result = await DockerExecutor.executeAction(action, containerName);

        // Explain action outcome
        const commentary = await LLMService.explainActionResult(action, containerName, result);
        const containersAtEnd = await DockerExecutor.getStatus();

        // Clear pending action
        this.pendingAction = null;

        return {
          query,
          initialIntent: {
            intent: "action",
            target: containerName,
            containerName,
            action,
            reasoning: "User confirmed mutation action."
          },
          steps: [
            {
              loopNumber: 1,
              action,
              target: containerName,
              thoughts: `Executing confirmed ${action} action on Docker container.`,
              observation: result
            }
          ],
          commentary,
          containersAtEnd,
          matchedContainerNames: [containerName]
        };
      }

      // Any other query clears the pending action
      this.pendingAction = null;

      // 2. Query Ollama to understand user intent
      console.log(`[AgentController] Parsing query intent with Ollama...`);
      let processedQuery = query;
      if (lowerQuery.includes("unhealthy")) {
        processedQuery = query.replace(/unhealthy/gi, "non-running");
      }
      const parsedIntent = await LLMService.translate(processedQuery);
      console.log(`[AgentController] Parsed intent: ${JSON.stringify(parsedIntent)}`);

      // Identify if any specific containers are mentioned/matched in the query
      const matchedContainerNames = new Set<string>();
      if (parsedIntent.containerName && parsedIntent.containerName !== 'none') {
        matchedContainerNames.add(parsedIntent.containerName.toLowerCase());
      }
      containers.forEach(c => {
        const regex = new RegExp(`\\b${c.name.toLowerCase()}\\b`, 'i');
        if (regex.test(query) || query.toLowerCase().includes(c.name.toLowerCase())) {
          matchedContainerNames.add(c.name.toLowerCase());
        }
      });
      const matchedContainers = containers.filter(c => matchedContainerNames.has(c.name.toLowerCase()));

      // Dispatch based on parsed intent type
      if (parsedIntent.intent === 'action') {
        let containerName = parsedIntent.containerName;
        if (!containerName) {
          // Manual name matching fallback if Ollama missed it
          const found = containers.find(c => query.toLowerCase().includes(c.name.toLowerCase()));
          if (found) containerName = found.name;
        }

        if (!containerName) {
          return {
            query,
            initialIntent: parsedIntent,
            steps: [],
            commentary: "Please specify which container you want to perform this action on.",
            containersAtEnd: containers
          };
        }

        const action = parsedIntent.action || 'restart';
        if (action !== 'start' && action !== 'stop' && action !== 'restart') {
          return defaultErrorResult(`Unsupported action: ${action}`);
        }

        // Store pending action and ask for confirmation
        this.pendingAction = { action, containerName };
        const capAction = action.charAt(0).toUpperCase() + action.slice(1);
        const confirmationPrompt = `${capAction} ${containerName}? Proceed?`;

        return {
          query,
          initialIntent: {
            ...parsedIntent,
            containerName
          },
          steps: [
            {
              loopNumber: 1,
              action,
              target: containerName,
              thoughts: "Mutation action requested. Awaiting confirmation.",
              observation: "Safety check triggered."
            }
          ],
          commentary: confirmationPrompt,
          containersAtEnd: containers,
          blockedActionTriggered: true,
          matchedContainerNames: [containerName]
        };
      }

      if (parsedIntent.intent === 'retrieval') {
        let filteredContainers = containers;
        const filter = parsedIntent.filter;

        if (isQueryingUnhealthy) {
          filteredContainers = unhealthyContainers;
        } else if (isQueryingHealthy) {
          filteredContainers = healthyContainers;
        } else if (filter === 'running') {
          filteredContainers = containers.filter(c => c.status === 'running');
        } else if (filter === 'exited' || (filter as string) === 'stopped') {
          filteredContainers = containers.filter(c => c.status !== 'running');
        } else {
          // Manual check for query content filter
          if (lowerQuery.includes("exited") || lowerQuery.includes("stopped") || lowerQuery.includes("non-running")) {
            filteredContainers = containers.filter(c => c.status !== 'running');
          } else if (lowerQuery.includes("running")) {
            filteredContainers = containers.filter(c => c.status === 'running');
          }
        }

        // Apply container name filter if matched
        if (matchedContainers.length > 0) {
          filteredContainers = filteredContainers.filter(c =>
            matchedContainers.some(mc => mc.name.toLowerCase() === c.name.toLowerCase())
          );
        }

        // Generate retrieval summary using healthType category
        const healthType = isQueryingHealthy ? 'healthy' : isQueryingUnhealthy ? 'unhealthy' : 'all';
        const summary = await LLMService.generateRetrievalSummary(filteredContainers, healthType);

        return {
          query,
          initialIntent: parsedIntent,
          steps: [
            {
              loopNumber: 1,
              action: "list",
              thoughts: "Querying Docker daemon for container status listing.",
              observation: { count: filteredContainers.length }
            }
          ],
          commentary: summary,
          containersAtEnd: filteredContainers,
          matchedContainerNames: matchedContainers.map(c => c.name)
        };
      }

      if (parsedIntent.intent === 'logs') {
        let containerName = parsedIntent.containerName;
        if (!containerName) {
          const found = containers.find(c => query.toLowerCase().includes(c.name.toLowerCase()));
          if (found) containerName = found.name;
        }

        if (!containerName) {
          return {
            query,
            initialIntent: parsedIntent,
            steps: [],
            commentary: "Please specify the container name to check logs.",
            containersAtEnd: containers
          };
        }

        const logsResult = await DockerExecutor.getLogs(containerName);
        const logsList = logsResult.success ? logsResult.logs : ['No logs available or failed to read logs.'];

        // Explain logs
        const explanation = await LLMService.explainLogs(containerName, logsList);

        // Format final commentary to display: Logs -> Short explanation
        const logsDisplay = logsList.slice(-10).join("\n");
        const formattedCommentary = `LOGS FOR ${containerName}:\n${logsDisplay || "(empty logs)"}\n\nAI LOG ANALYSIS:\n${explanation}`;

        return {
          query,
          initialIntent: parsedIntent,
          steps: [
            {
              loopNumber: 1,
              action: "logs",
              target: containerName,
              thoughts: "Reading target container stdout/stderr stream.",
              observation: { logLines: logsList.length }
            }
          ],
          commentary: formattedCommentary,
          containersAtEnd: containers,
          matchedContainerNames: [containerName]
        };
      }

      if (parsedIntent.intent === 'reasoning') {
        let filteredContainers = containers;
        if (isQueryingUnhealthy) {
          filteredContainers = unhealthyContainers;
        } else if (isQueryingHealthy) {
          filteredContainers = healthyContainers;
        }

        if (matchedContainers.length > 0) {
          filteredContainers = filteredContainers.filter(c =>
            matchedContainers.some(mc => mc.name.toLowerCase() === c.name.toLowerCase())
          );
        }

        // Generate reasoning summary using healthType category
        const healthType = isQueryingHealthy ? 'healthy' : isQueryingUnhealthy ? 'unhealthy' : 'all';
        const summary = await LLMService.generateReasoningSummary(query, filteredContainers, healthType);

        return {
          query,
          initialIntent: parsedIntent,
          steps: [
            {
              loopNumber: 1,
              action: "stats",
              thoughts: "Inspecting host resource configurations.",
              observation: { containerCount: filteredContainers.length }
            }
          ],
          commentary: summary,
          containersAtEnd: filteredContainers,
          matchedContainerNames: matchedContainers.map(c => c.name)
        };
      }

      // Default to general reasoning status
      let finalContainers = containers;
      if (isQueryingUnhealthy) {
        finalContainers = unhealthyContainers;
      } else if (isQueryingHealthy) {
        finalContainers = healthyContainers;
      }
      if (matchedContainers.length > 0) {
        finalContainers = finalContainers.filter(c =>
          matchedContainers.some(mc => mc.name.toLowerCase() === c.name.toLowerCase())
        );
      }
      const healthType = isQueryingHealthy ? 'healthy' : isQueryingUnhealthy ? 'unhealthy' : 'all';
      const defaultSummary = await LLMService.generateReasoningSummary(query, finalContainers, healthType);
      return {
        query,
        initialIntent: parsedIntent,
        steps: [],
        commentary: defaultSummary,
        containersAtEnd: finalContainers,
        matchedContainerNames: matchedContainers.map(c => c.name)
      };

    } catch (err: any) {
      console.error("[AgentController] AI query execution failed:", err.message);
      return defaultErrorResult(err.message || String(err));
    }
  }
}
