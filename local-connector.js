import express from "express";
import { DockerExecutor } from "./src/server/dockerExecutor.js";
import { AgentController } from "./src/server/agentController.js";
import { LLMService } from "./src/server/llmService.js";

const app = express();
const PORT = 43210;

// Enable CORS for localhost access from the hosted website
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// 1. Health check - verifies if local Docker and local Ollama are online
app.get("/api/health", async (req, res) => {
  let dockerConnected = false;
  let ollamaConnected = false;

  try {
    await DockerExecutor.getInfo();
    dockerConnected = true;
  } catch (err) {}

  try {
    const ollamaStatus = await LLMService.checkOllamaConnection();
    ollamaConnected = ollamaStatus.success;
  } catch (err) {}

  res.json({
    success: true,
    dockerConnected,
    ollamaConnected,
    timestamp: new Date().toISOString(),
    service: "Docker Local Connector"
  });
});

// 2. Fetch full Docker state (metrics, states, images, engine info)
app.get("/api/docker/state", async (req, res) => {
  try {
    const summary = await DockerExecutor.getSummary();
    const statusList = await DockerExecutor.getStatus();
    const healthList = await DockerExecutor.getHealth();
    const statsList = await DockerExecutor.getStats();

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
        createdAt: item.createdAt,
        ageDescription: item.ageDescription
      };
    });

    res.json({
      success: true,
      summary,
      containers: consolidated,
      images: await DockerExecutor.getImages(),
      info: await DockerExecutor.getInfo()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Natural Language Intelligent Search
app.post("/api/docker/query", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ success: false, error: "Query string is required." });
  }
  try {
    console.log(`[Connector] Processing AI prompt: "${query}"`);
    const result = await AgentController.runAgent(query);
    res.json({ success: true, result });
  } catch (err) {
    console.error("[Connector Error] Query failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Force a simulation tick
app.post("/api/docker/tick", (req, res) => {
  try {
    DockerExecutor.tickSimulation();
    res.json({ success: true, message: "Simulation state updated." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Fetch single container logs
app.get("/api/docker/logs/:id", async (req, res) => {
  const containerId = req.params.id;
  try {
    const logData = await DockerExecutor.getLogs(containerId);
    res.json(logData);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5a. Unified LLM status check
app.get("/api/ollama/status", async (req, res) => {
  const check = await LLMService.checkOllamaConnection();
  res.json({
    success: check.success,
    url: LLMService.getOllamaUrl(),
    model: LLMService.getOllamaModel(),
    models: check.models,
    error: check.error,
    activeProvider: LLMService.getActiveProvider(),
    geminiAvailable: false
  });
});

// 5b. Update Ollama endpoint/model config
app.post("/api/ollama/config", async (req, res) => {
  const { url, model } = req.body;
  if (url !== undefined) {
    LLMService.setOllamaUrl(url);
  }
  if (model !== undefined) {
    LLMService.setOllamaModel(model);
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
    return res.status(400).json({ success: false, error: "Action and containerName are required." });
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
      res.json({ success: true, message: result.message, container: result.data });
    } else {
      res.status(404).json({ success: false, error: result.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6a. Get current Docker Target Engine connection config
app.get("/api/docker/config", (req, res) => {
  res.json({
    success: true,
    mode: DockerExecutor.getDockerMode(),
    hostUrl: DockerExecutor.getDockerHostUrl()
  });
});

// 6b. Update Docker host settings
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

    try {
      systemInfo = await DockerExecutor.getInfo();
      connectionOk = true;
    } catch (err) {
      errorMsg = err.message || String(err);
    }

    res.json({
      success: true,
      mode: DockerExecutor.getDockerMode(),
      hostUrl: DockerExecutor.getDockerHostUrl(),
      connectionOk,
      errorMsg,
      info: systemInfo
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("=================================================");
  console.log(`🐳 Local Connector started on http://127.0.0.1:${PORT}`);
  console.log("Only requests from localhost are permitted.");
  console.log("=================================================");
});
