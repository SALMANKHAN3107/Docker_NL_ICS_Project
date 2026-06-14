/**
 * Express + Vite Development & Production Server
 * Binds exclusively to Port 3000 per environment rules.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

// Import core backend services
import { DockerExecutor } from "./src/server/dockerExecutor.js";
import { AgentController } from "./src/server/agentController.js";
import { LLMService } from "./src/server/llmService.js";

dotenv.config();

const getFilename = () => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return fileURLToPath(import.meta.url);
    }
  } catch (e) {}
  return typeof __filename !== "undefined" ? __filename : "";
};
const __filename = getFilename();
const __dirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  // Middleware
  app.use(express.json());

  // API ENDPOINTS

  // 1. Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      service: "Docker NL Dashboard Broker"
    });
  });

  // 2. Fetch full Docker state (metrics, states, health, lists)
  app.get("/api/docker/state", async (req, res) => {
    try {
      const summary = await DockerExecutor.getSummary();
      const statusList = await DockerExecutor.getStatus();
      const healthList = await DockerExecutor.getHealth();
      const statsList = await DockerExecutor.getStats();

      // Combined view for the container tables & dashboard metric pages
      const consolidated = statusList.map(item => {
        const healthItem = healthList.find(h => h.name === item.name);
        const statsItem = statsList.find(s => s.name === item.name);
        return {
          ...item,
          health: healthItem?.health || "none",
          issue: healthItem?.issue || "None",
          cpu: statsItem?.cpu || "0%",
          memory: statsItem?.memory || "0MB",
          memoryUsagePercentage: statsItem?.memoryUsagePercentage || "0%",
          createdAt: (item as any).createdAt,
          ageDescription: (item as any).ageDescription
        };
      });

      res.json({
        success: true,
        summary,
        containers: consolidated,
        images: await DockerExecutor.getImages(),
        info: await DockerExecutor.getInfo()
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. Natural Language Intelligent Search / Agent controller execution
  app.post("/api/docker/query", async (req, res) => {
    const { query } = req.body;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: "Query string is required." });
    }

    try {
      console.log(`[Server] Processing AI prompt: "${query}"`);
      const result = await AgentController.runAgent(query);
      res.json({
        success: true,
        result
      });
    } catch (err: any) {
      console.error("[Server Error] Query failed:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. Force a simulation tick (fluctuates resource values to show real responsiveness)
  app.post("/api/docker/tick", (req, res) => {
    try {
      DockerExecutor.tickSimulation();
      res.json({ success: true, message: "Simulation state updated to mimic live load fluctuations." });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. Fetch single container log inspection
  app.get("/api/docker/logs/:id", async (req, res) => {
    const containerId = req.params.id;
    try {
      const logData = await DockerExecutor.getLogs(containerId);
      res.json(logData);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5a. Unified LLM configuration and status check
  app.get("/api/ollama/status", async (req, res) => {
    const check = await LLMService.checkOllamaConnection();
    res.json({
      success: check.success,
      url: LLMService.getOllamaUrl(),
      model: LLMService.getOllamaModel(),
      models: check.models,
      error: check.error,
      // Add provider details:
      activeProvider: LLMService.getActiveProvider(),
      geminiAvailable: !!process.env.GEMINI_API_KEY
    });
  });

  // Dedicated connection validator route
  app.get("/api/ollama/test-connection", async (req, res) => {
    try {
      const check = await LLMService.checkOllamaConnection();
      const activeModel = LLMService.getOllamaModel();
      const modelExists = check.models.some((m: string) => m.toLowerCase().includes(activeModel.toLowerCase()));
      
      let testOutput = "";
      let testSuccess = false;
      let testError = "";

      if (check.success) {
        try {
          testOutput = await LLMService.callOllama("Hello");
          testSuccess = true;
        } catch (err: any) {
          testError = err.message || String(err);
        }
      }

      res.json({
        success: check.success,
        url: LLMService.getOllamaUrl(),
        activeModel,
        modelExists,
        models: check.models,
        testPrompt: "Hello",
        testOutput,
        testSuccess,
        testError,
        error: check.error
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Dedicated raw query bypass route (now integrates Docker context & Ollama reasoning)
  app.post("/api/ollama/query-raw", async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ success: false, error: "Prompt parameter is required." });
    }

    // 1. Connection Validation Checks (Localhost Ollama ONLY)
    const ollamaUrl = LLMService.getOllamaUrl();
    const activeProvider = LLMService.getActiveProvider();
    const isLocalhost = ollamaUrl.includes("localhost") || ollamaUrl.includes("127.0.0.1") || ollamaUrl.includes("::1");

    let isOllamaAvailable = false;
    if (activeProvider === "ollama" && isLocalhost) {
      try {
        const ollamaStatus = await LLMService.checkOllamaConnection();
        if (ollamaStatus.success) {
          const activeModel = LLMService.getOllamaModel();
          const cleanActive = activeModel.toLowerCase().split(":")[0];
          const modelExists = ollamaStatus.models.some((m: string) => {
            const lm = m.toLowerCase();
            return lm === activeModel.toLowerCase() || lm.startsWith(cleanActive + ":") || lm === cleanActive;
          });
          if (modelExists) {
            // Test if request is accepted and response is returned
            const pingResp = await LLMService.callOllama("say ok", false);
            if (pingResp && pingResp.trim().length > 0) {
              isOllamaAvailable = true;
            }
          }
        }
      } catch (err) {
        isOllamaAvailable = false;
      }
    }

    if (!isOllamaAvailable) {
      return res.json({
        success: true,
        response: `AI Status:\nLocal Ollama unavailable.\n\nStop testing.`,
        dockerContextTriggered: false
      });
    }

    // 2. Fetch Docker data (REAL Docker runtime data ONLY)
    let info, containers, stats;
    try {
      info = await DockerExecutor.getInfo();
      containers = await DockerExecutor.getStatus();
      stats = await DockerExecutor.getStats();
    } catch (err: any) {
      return res.json({
        success: true,
        response: `AI Status:\nNo real Docker data available.\n\nStop analysis.`,
        dockerContextTriggered: false
      });
    }

    if (!containers || containers.length === 0) {
      return res.json({
        success: true,
        response: `AI Status:\nNo real Docker data available.\n\nStop analysis.`,
        dockerContextTriggered: false
      });
    }

    // Fetch logs for all containers and build prompt
    let dockerContext = `REAL DOCKER RUNTIME DATA ONLY (Use ONLY this data):
Docker Version: ${info.version}
Total Containers: ${info.containersTotal}
Running Containers: ${info.runningContainers}

Active Containers:
`;
    for (const c of containers) {
      const stat = stats.find(s => s.name === c.name);
      const logData = await DockerExecutor.getLogs(c.name);
      const logsText = logData.success && Array.isArray(logData.logs)
        ? logData.logs.slice(-3).join("\n")
        : "";
      
      dockerContext += `- Container Name: ${c.name}
  ID: ${c.id}
  Image: ${c.image}
  Status: ${c.status}
  Health status: ${c.health}
  CPU Usage: ${stat ? stat.cpu : "0%"}
  Memory Usage: ${stat ? stat.memory : "0MB"}
  Restart Count: ${c.restartCount}
  Uptime: ${c.uptime}
  Logs: ${logsText || "none"}
`;
    }

    // We executed docker inspect and docker logs internally to fetch this runtime telemetry
    const executedCommandsList = containers.flatMap(c => [
      `docker inspect ${c.name}`,
      `docker logs ${c.name}`
    ]);

    const promptInstructions = `Analyze the real Docker runtime data above to answer the user query: "${prompt}"

Rules:
1. Use ONLY the real containers and metrics provided above. Do not create, assume, or hallucinate containers.
2. The entire response MUST be between 65 and 75 words. This is a strict constraint. If your answer is too short, elaborate by describing the status, CPU, memory, and health check details for each container to meet this length target. Do not output fewer than 65 words.
3. No tables. No markdown formatting for headers. Use plain text.
4. Mention the actual metrics (CPU, memory, health, restarts, or exit code) of the containers.
5. If you mention any commands executed, they must be commands that were actually run internally:
   - "docker inspect <containerName>" (used to verify exit details/restarts)
   - "docker logs <containerName>" (used to retrieve stderr/stdout logs)
   Format them exactly as:
   Executed Command: <command>
   Purpose:
   <why it was run>
   If no commands were executed or relevant, do not include that section.
6. Make sure your response relates directly to the observed metrics and real container names. Keep reasoning simple and non-technical.`;

    let response = "";
    let responseSuccess = "FAILED";
    let outputQuality = "FAIL";
    let reasonText = "Response generation failed or timed out.";
    let allChecksPassed = false;
    let latency = 0;

    const activeModel = LLMService.getOllamaModel();
    console.log(`[query-raw test mode] Executing Ollama test request with model '${activeModel}'...`);

    // We can attempt up to 2 times (regenerate once if validation fails)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const startTime = Date.now();
      try {
        response = await LLMService.callOllama(`${dockerContext}\n\n${promptInstructions}`, false);
        latency = Date.now() - startTime;
        if (response && response.trim().length > 0) {
          responseSuccess = "SUCCESS";
        } else {
          responseSuccess = "FAILED";
        }
      } catch (err: any) {
        reasonText = `Ollama call error: ${err.message || err}`;
        responseSuccess = "FAILED";
        response = "";
      }

      if (response) {
        const wordCount = response.split(/\s+/).filter(Boolean).length;
        const wordCountOk = wordCount >= 60 && wordCount <= 80;
        const lowercaseResponse = response.toLowerCase();
        
        // Output relevant to input: Check if the response contains container or query-related terms
        const queryWords = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
        const mentionsQueryTopic = queryWords.some(w => lowercaseResponse.includes(w)) || 
                                   lowercaseResponse.includes("container") || 
                                   lowercaseResponse.includes("docker");

        const mentionsMetrics = lowercaseResponse.includes("cpu") || 
                                 lowercaseResponse.includes("memory") || 
                                 lowercaseResponse.includes("status") ||
                                 lowercaseResponse.includes("run") ||
                                 lowercaseResponse.includes("exit") ||
                                 lowercaseResponse.includes("restart") ||
                                 lowercaseResponse.includes("health") ||
                                 lowercaseResponse.includes("%") ||
                                 lowercaseResponse.includes("mb");

        const mentionedRealContainers = containers.filter(c => lowercaseResponse.includes(c.name.toLowerCase()));
        const mentionsRealContainer = mentionedRealContainers.length > 0;

        const fakeContainerNames = ["auth-service", "db-container", "web-app", "redis-cache", "postgres-db"];
        const hasFakeContainers = fakeContainerNames.some(fakeName => 
          lowercaseResponse.includes(fakeName) && !containers.some(c => c.name.toLowerCase() === fakeName)
        );

        // Word repetition / loop detection
        const sentences = response.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 10);
        let sentenceRepeated = false;
        const sentenceCounts: Record<string, number> = {};
        for (const s of sentences) {
          sentenceCounts[s] = (sentenceCounts[s] || 0) + 1;
          if (sentenceCounts[s] > 1) {
            sentenceRepeated = true;
            break;
          }
        }

        const wordsList = response.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        let phraseRepeated = false;
        if (wordsList.length >= 6) {
          for (let i = 0; i < wordsList.length - 5; i++) {
            const phrase = wordsList.slice(i, i + 3).join(" ");
            const rest = wordsList.slice(i + 3).join(" ");
            if (rest.includes(phrase)) {
              let count = 0;
              let pos = 0;
              while (true) {
                const idx = wordsList.slice(pos).findIndex((_, subIdx) => {
                  return wordsList.slice(pos + subIdx, pos + subIdx + 3).join(" ") === phrase;
                });
                if (idx === -1) break;
                count++;
                pos = pos + idx + 1;
              }
              if (count > 2) {
                phraseRepeated = true;
                break;
              }
            }
          }
        }
        const noRepetition = !sentenceRepeated && !phraseRepeated;

        const commandRegex = /docker\s+[a-z0-9-_]+(\s+[a-z0-9-_.]+)?/g;
        const mentionedCommands = response.match(commandRegex) || [];
        let commandsValid = true;
        for (const cmd of mentionedCommands) {
          const cleanCmd = cmd.toLowerCase().trim();
          const isAllowed = cleanCmd.includes("inspect") ||
                            cleanCmd.includes("logs") ||
                            cleanCmd.includes("ps") ||
                            cleanCmd.includes("stats") ||
                            cleanCmd.includes("info") ||
                            cleanCmd.includes("version");
          if (!isAllowed) {
            commandsValid = false;
            break;
          }
        }

        const receivedWithinTime = latency <= 300000;

        if (!receivedWithinTime) {
          reasonText = `Response took too long (${(latency / 1000).toFixed(1)}s).`;
        } else if (!wordCountOk) {
          reasonText = `Word count is ${wordCount} (target: 60-80 words).`;
        } else if (!mentionsQueryTopic) {
          reasonText = "Response does not address the query topic.";
        } else if (!mentionsMetrics) {
          reasonText = "Response does not mention observed metrics (CPU, memory, status, restarts, etc.).";
        } else if (!mentionsRealContainer) {
          reasonText = "Response does not reference any real container names.";
        } else if (hasFakeContainers) {
          reasonText = "Response references fake or assumed containers.";
        } else if (!noRepetition) {
          reasonText = "Response contains repetitive phrases or sentence loops.";
        } else if (!commandsValid) {
          reasonText = "Response mentions commands that were not actually executed internally.";
        } else {
          outputQuality = "PASS";
          reasonText = "All validation checks passed successfully.";
          allChecksPassed = true;
          break; // Validation success, stop attempts
        }
      }

      console.warn(`[query-raw test mode] Attempt ${attempt} failed validation: ${reasonText}. Regenerating...`);
    }

    // Format the final response to append the test report
    let formattedResponse = response ? `${response}\n\n` : "";
    formattedResponse += `Connection:\nPASS\n\n`;
    formattedResponse += `Model Loaded:\nYES\n\n`;
    formattedResponse += `Response:\n${responseSuccess}\n\n`;
    formattedResponse += `Output Quality:\n${outputQuality}\n\n`;
    formattedResponse += `Reason: ${reasonText}`;

    if (allChecksPassed) {
      formattedResponse += `\n\nAI Integration Test:\nSUCCESS\n\nReady for manual integration.`;
    }

    res.json({
      success: true,
      response: formattedResponse,
      dockerContextTriggered: true
    });
  });

  // Serve simple HTML Ollama Connection Test Page
  app.get("/ollama-test", (req, res) => {
    res.sendFile(path.join(process.cwd(), "ollama-test.html"));
  });

  // Serve simple HTML Docker Connection Test Page
  app.get("/docker-test", (req, res) => {
    res.sendFile(path.join(process.cwd(), "docker-test.html"));
  });

  // Dedicated Docker connection check endpoint
  app.get("/api/docker/test-connection", async (req, res) => {
    try {
      const info = await DockerExecutor.getInfo();
      const statusList = await DockerExecutor.getStatus();
      res.json({
        success: true,
        mode: DockerExecutor.getDockerMode(),
        info: {
          ...info,
          containerCount: statusList.length,
          source: "Local Docker Desktop"
        }
      });
    } catch (err: any) {
      const detailedError = DockerExecutor.getDetailedError(err);
      res.status(500).json({
        success: false,
        mode: DockerExecutor.getDockerMode(),
        error: detailedError
      });
    }
  });

  // Dedicated Docker container list endpoint
  app.get("/api/docker/test-containers", async (req, res) => {
    try {
      const containers = await DockerExecutor.getStatus();
      if (containers.length === 0) {
        return res.json({
          success: true,
          count: 0,
          containers: [],
          message: "No containers found"
        });
      }
      res.json({
        success: true,
        count: containers.length,
        containers: containers.map(c => ({
          id: c.id,
          name: c.name,
          image: c.image,
          status: c.status,
          cpu: c.cpu,
          memory: c.memory,
          lastUpdated: new Date().toISOString()
        }))
      });
    } catch (err: any) {
      const detailedError = DockerExecutor.getDetailedError(err);
      res.status(500).json({ success: false, error: detailedError });
    }
  });

  // Dedicated Docker metrics endpoint
  app.get("/api/docker/test-metrics", async (req, res) => {
    try {
      const metrics = await DockerExecutor.getStats();
      res.json({
        success: true,
        metrics: metrics.map(m => ({
          ...m,
          lastUpdated: new Date().toISOString()
        }))
      });
    } catch (err: any) {
      const detailedError = DockerExecutor.getDetailedError(err);
      res.status(500).json({ success: false, error: detailedError });
    }
  });

  app.post("/api/ollama/config", async (req, res) => {
    const { url, model, activeProvider } = req.body;
    if (url !== undefined) {
      LLMService.setOllamaUrl(url);
    }
    if (model !== undefined) {
      LLMService.setOllamaModel(model);
    }
    if (activeProvider !== undefined && (activeProvider === "gemini" || activeProvider === "ollama")) {
      LLMService.setActiveProvider(activeProvider);
    }
    const check = await LLMService.checkOllamaConnection();
    res.json({
      success: true,
      currentUrl: LLMService.getOllamaUrl(),
      currentModel: LLMService.getOllamaModel(),
      activeProvider: LLMService.getActiveProvider(),
      status: check
    });
  });

  // 6. Direct container control operations (Start, Stop, Restart)
  app.post("/api/docker/control", async (req, res) => {
    const { action, containerName } = req.body;
    if (!action || !containerName) {
      return res.status(400).json({ success: false, error: "Action and containerName parameters are required." });
    }

    try {
      let result;
      const cleanAction = action.toLowerCase().trim();

      if (cleanAction === "start") {
        result = await DockerExecutor.startContainer(containerName);
      } else if (cleanAction === "stop") {
        result = await DockerExecutor.stopContainer(containerName);
      } else if (cleanAction === "restart") {
        result = await DockerExecutor.restartContainer(containerName);
      } else {
        return res.status(400).json({ success: false, error: `Unsupported control action: ${action}` });
      }

      if (result.success) {
        res.json({
          success: true,
          message: result.message,
          container: result.data
        });
      } else {
        res.status(404).json({ success: false, error: result.message });
      }
    } catch (err: any) {
      console.error("[Server Error] Direct control execution failed:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6a. Expose Docker Engine connection config endpoints (Simulation vs Live Engine REST API)
  app.get("/api/docker/config", (req, res) => {
    try {
      res.json({
        success: true,
        mode: DockerExecutor.getDockerMode(),
        hostUrl: DockerExecutor.getDockerHostUrl()
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/docker/config", async (req, res) => {
    const { mode, hostUrl } = req.body;
    try {
      if (mode !== undefined && (mode === "simulation" || mode === "live")) {
        DockerExecutor.setDockerMode(mode);
      }
      if (hostUrl !== undefined && typeof hostUrl === "string") {
        DockerExecutor.setDockerHostUrl(hostUrl);
      }

      let connectionOk = false;
      let errorMsg = null;
      let systemInfo = null;

      if (DockerExecutor.getDockerMode() === "live") {
        try {
          systemInfo = await DockerExecutor.getInfo();
          connectionOk = true;
        } catch (err: any) {
          errorMsg = err.message || String(err);
        }
      } else {
        connectionOk = true; // Simulation mode is always deemed healthy
      }

      res.json({
        success: true,
        mode: DockerExecutor.getDockerMode(),
        hostUrl: DockerExecutor.getDockerHostUrl(),
        connectionOk,
        errorMsg,
        info: systemInfo
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Vite Assets Serving and SPA Fallback
  if (process.env.NODE_ENV !== "production") {
    console.log("[Server] Mounting Vite middleware in development...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[Server] Serving production assets from ./dist...");
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const HOST = process.env.HOST || "0.0.0.0";
  const server = app.listen(PORT, HOST, async () => {
    console.log(`[Ready] Docker NL Health Dashboard server active on http://${HOST}:${PORT}`);
    
    console.log("\n=================================================");
    console.log("DOCKER CONNECTION VERIFICATION AT STARTUP");
    console.log("=================================================");
    try {
      const info = await DockerExecutor.getInfo();
      const statusList = await DockerExecutor.getStatus();
      console.log(`Connection Status: Connected to Local Docker`);
      console.log(`Container Count: ${statusList.length}`);
      console.log(`Docker Version: ${info.version}`);
      console.log(`Environment: Docker Desktop`);
    } catch (err: any) {
      console.log(`Connection Status: Application not connected to local Docker.`);
      console.log(`Details: ${err.message}`);
    }
    console.log("=================================================\n");
  });
  server.setTimeout(300000); // 5 minutes connection timeout
}

startServer();
