/**
 * Toonflow AI供应商 - RunningHub
 * @version 2.0
 *
 * 说明：
 * RunningHub 是工作流平台，需要配置工作流ID来执行任务。
 * 通过 /task/openapi/create 提交任务，/task/openapi/status 轮询状态，
 * /task/openapi/outputs 获取结果。
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  author: string;
  name: string;
  description?: string;
  icon?: string;
  inputs: {
    key: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    placeholder?: string;
    disabled?: boolean;
  }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "runninghub",
  version: "1.0",
  author: "Toonflow",
  name: "RunningHub",
  description:
    "RunningHub 工作流平台适配，支持图片生成、视频生成等多种工作流任务。\n\n需要在 RunningHub 平台创建工作流并获取 Workflow ID。",
  inputs: [
    {
      key: "apiKey",
      label: "API密钥",
      type: "password",
      required: true,
      placeholder: "请输入 RunningHub 的 API Key",
    },
    {
      key: "baseUrl",
      label: "请求地址",
      type: "url",
      required: true,
      placeholder: "示例：https://www.runninghub.com",
    },
    {
      key: "defaultWorkflowId",
      label: "默认工作流ID",
      type: "text",
      required: false,
      placeholder: "留空则使用模型配置中的工作流ID",
    },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://www.runninghub.com",
    defaultWorkflowId: "",
  },
  models: [
    // 示例：图片生成工作流
    {
      name: "图片生成",
      modelName: "",
      type: "image",
      mode: ["text", "singleImage"],
    },
    // 示例：视频生成工作流
    {
      name: "视频生成",
      modelName: "",
      type: "video",
      mode: ["text", "singleImage"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      name: "语音合成",
      modelName: "",
      type: "tts",
      voices: [],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getBaseUrl = (): string => {
  return vendor.inputValues.baseUrl.replace(/\/$/, "");
};

const getHeaders = (): Record<string, string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API Key");
  const url = new URL(getBaseUrl());
  return {
    Host: url.host,
    Authorization: `Bearer ${vendor.inputValues.apiKey}`,
    "Content-Type": "application/json",
  };
};

const extractRawBase64 = (ref: ReferenceList): string => {
  return ref.base64.replace(/^data:[^;]+;base64,/, "");
};

// ============================================================
// RunningHub API 调用
// ============================================================

interface NodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: string;
}

interface TaskOutput {
  fileUrl: string;
  fileType: string;
  taskCostTime: string;
  nodeId: string;
  thirdPartyConsumeMoney: string;
  consumeMoney: string;
  consumeCoins: string;
}

type TaskStatus = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED";

/**
 * 创建任务
 */
const createTask = async (workflowId: string, nodeInfoList: NodeInfo[] = []): Promise<string> => {
  const url = `${getBaseUrl()}/task/openapi/create`;
  const body = {
    apiKey: vendor.inputValues.apiKey,
    workflowId,
    nodeInfoList,
    addMetadata: true,
  };

  logger(`[RunningHub] 创建任务，workflowId: ${workflowId}`);
  const resp = await axios.post(url, body, { headers: getHeaders() });

  if (resp.data.code !== 0 && resp.data.code !== 200) {
    throw new Error(`创建任务失败: ${resp.data.msg || JSON.stringify(resp.data)}`);
  }

  const taskId = resp.data.data?.taskId;
  if (!taskId) {
    throw new Error(`创建任务失败: 未获取到 taskId`);
  }

  logger(`[RunningHub] 任务已创建，taskId: ${taskId}`);
  return taskId;
};

/**
 * 获取任务状态
 */
const getTaskStatus = async (taskId: string): Promise<TaskStatus> => {
  const url = `${getBaseUrl()}/task/openapi/status`;
  const resp = await axios.post(
    url,
    { apiKey: vendor.inputValues.apiKey, taskId },
    { headers: getHeaders() },
  );

  const status = resp.data.data?.status;
  if (!status) {
    throw new Error(`获取任务状态失败: ${JSON.stringify(resp.data)}`);
  }

  return status;
};

/**
 * 获取任务输出
 */
const getTaskOutputs = async (taskId: string): Promise<TaskOutput[]> => {
  const url = `${getBaseUrl()}/task/openapi/outputs`;
  const resp = await axios.post(
    url,
    { apiKey: vendor.inputValues.apiKey, taskId },
    { headers: getHeaders() },
  );

  return resp.data.data ?? [];
};

/**
 * 上传资源文件
 */
const uploadResource = async (base64Data: string): Promise<string> => {
  // 去掉 base64 头
  const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
  // 将 base64 转换为 ArrayBuffer
  const binaryString = atob(rawBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes]);

  const url = `${getBaseUrl()}/openapi/v2/media/upload/binary`;
  const formData = new FormData();
  formData.append("file", blob);

  // 上传需要不同的 headers（不能有 Content-Type，让浏览器自动设置）
  const uploadHeaders: Record<string, string> = {
    Host: new URL(getBaseUrl()).host,
    Authorization: `Bearer ${vendor.inputValues.apiKey}`,
  };

  const resp = await axios.post(url, formData, { headers: uploadHeaders });

  if (resp.data.code !== 0 && resp.data.code !== 200) {
    throw new Error(`上传资源失败: ${resp.data.msg || JSON.stringify(resp.data)}`);
  }

  const downloadUrl = resp.data.data?.download_url;
  if (!downloadUrl) {
    throw new Error(`上传资源失败: 未获取到 download_url`);
  }

  logger(`[RunningHub] 资源上传成功: ${downloadUrl}`);
  return downloadUrl;
};

/**
 * 提交并轮询任务
 */
const submitAndPoll = async (
  workflowId: string,
  nodeInfoList: NodeInfo[] = [],
  pollIntervalMs = 30000,
  timeoutMs = 1800000,
): Promise<string> => {
  const taskId = await createTask(workflowId, nodeInfoList);

  const result = await pollTask(
    async (): Promise<PollResult> => {
      try {
        const status = await getTaskStatus(taskId);
        logger(`[RunningHub] 任务状态: ${status}`);

        if (status === "SUCCESS") {
          const outputs = await getTaskOutputs(taskId);
          if (outputs.length === 0) {
            return { completed: true, error: "任务成功但无输出结果" };
          }
          // 优先返回第一个图片或视频文件
          const firstOutput = outputs.find(
            (o) => o.fileType === "image" || o.fileType === "video",
          ) || outputs[0];
          return { completed: true, data: firstOutput.fileUrl };
        }

        if (status === "FAILED") {
          return { completed: true, error: "任务执行失败" };
        }

        return { completed: false };
      } catch (err: any) {
        logger(`[RunningHub] 轮询异常: ${err.message}`);
        // 网络错误继续重试
        if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(String(err?.message))) {
          return { completed: false };
        }
        return { completed: true, error: err.message };
      }
    },
    pollIntervalMs,
    timeoutMs,
  );

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("任务完成但未获取到结果地址");

  logger(`[RunningHub] 获取到结果: ${result.data}`);
  return result.data;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (_model: TextModel, _think: boolean, _thinkLevel: 0 | 1 | 2 | 3): any => {
  throw new Error("RunningHub 不支持直接文本对话，请配置工作流");
};

const imageRequest = async (config: ImageConfig, _model: ImageModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API Key");

  // 获取工作流ID：优先使用模型配置的 modelName，其次使用默认工作流ID
  const workflowId = _model.modelName || vendor.inputValues.defaultWorkflowId;
  if (!workflowId) {
    throw new Error("未配置工作流ID，请在水球设置中填写默认工作流ID或选择工作流模型");
  }

  const nodeInfoList: NodeInfo[] = [];

  // 设置提示词
  if (config.prompt) {
    nodeInfoList.push({ nodeId: "", fieldName: "prompt", fieldValue: config.prompt });
  }

  // 处理参考图
  const imageRefs = (config.referenceList || []).filter((r) => r.type === "image");
  if (imageRefs.length > 0) {
    // 上传第一张参考图
    const imageUrl = await uploadResource(imageRefs[0].base64);
    nodeInfoList.push({ nodeId: "", fieldName: "input_image", fieldValue: imageUrl });
  }

  // 设置宽高比
  if (config.aspectRatio) {
    nodeInfoList.push({ nodeId: "", fieldName: "aspect_ratio", fieldValue: config.aspectRatio });
  }

  const resultUrl = await submitAndPoll(workflowId, nodeInfoList);
  return await urlToBase64(resultUrl);
};

const videoRequest = async (config: VideoConfig, _model: VideoModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API Key");

  // 获取工作流ID
  const workflowId = _model.modelName || vendor.inputValues.defaultWorkflowId;
  if (!workflowId) {
    throw new Error("未配置工作流ID，请在水球设置中填写默认工作流ID或选择工作流模型");
  }

  const nodeInfoList: NodeInfo[] = [];

  // 设置提示词
  if (config.prompt) {
    nodeInfoList.push({ nodeId: "", fieldName: "prompt", fieldValue: config.prompt });
  }

  // 设置时长
  if (config.duration) {
    nodeInfoList.push({ nodeId: "", fieldName: "duration", fieldValue: String(config.duration) });
  }

  // 设置宽高比
  if (config.aspectRatio) {
    nodeInfoList.push({ nodeId: "", fieldName: "aspect_ratio", fieldValue: config.aspectRatio });
  }

  // 处理参考图
  const imageRefs = (config.referenceList || []).filter((r) => r.type === "image");
  if (imageRefs.length > 0) {
    const imageUrl = await uploadResource(imageRefs[0].base64);
    nodeInfoList.push({ nodeId: "", fieldName: "input_image", fieldValue: imageUrl });
  }

  // 处理参考视频
  const videoRefs = (config.referenceList || []).filter((r) => r.type === "video");
  if (videoRefs.length > 0) {
    const videoUrl = await uploadResource(videoRefs[0].base64);
    nodeInfoList.push({ nodeId: "", fieldName: "input_video", fieldValue: videoUrl });
  }

  const resultUrl = await submitAndPoll(workflowId, nodeInfoList);
  return await urlToBase64(resultUrl);
};

const ttsRequest = async (config: TTSConfig, _model: TTSModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API Key");

  const workflowId = _model.modelName || vendor.inputValues.defaultWorkflowId;
  if (!workflowId) {
    throw new Error("未配置工作流ID，请在水球设置中填写默认工作流ID或选择工作流模型");
  }

  const nodeInfoList: NodeInfo[] = [];

  // 设置要合成的文本
  if (config.text) {
    nodeInfoList.push({ nodeId: "", fieldName: "text", fieldValue: config.text });
  }

  // 设置语音
  if (config.voice) {
    nodeInfoList.push({ nodeId: "", fieldName: "voice", fieldValue: config.voice });
  }

  // 设置语速
  if (config.speechRate) {
    nodeInfoList.push({ nodeId: "", fieldName: "speech_rate", fieldValue: String(config.speechRate) });
  }

  // 设置音调
  if (config.pitchRate) {
    nodeInfoList.push({ nodeId: "", fieldName: "pitch_rate", fieldValue: String(config.pitchRate) });
  }

  // 设置音量
  if (config.volume) {
    nodeInfoList.push({ nodeId: "", fieldName: "volume", fieldValue: String(config.volume) });
  }

  // 处理音频参考
  const audioRefs = (config.referenceList || []).filter((r) => r.type === "audio");
  if (audioRefs.length > 0) {
    const audioUrl = await uploadResource(audioRefs[0].base64);
    nodeInfoList.push({ nodeId: "", fieldName: "reference_audio", fieldValue: audioUrl });
  }

  const resultUrl = await submitAndPoll(workflowId, nodeInfoList);
  // TTS 返回的是音频文件，转换为 base64
  return await urlToBase64(resultUrl);
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};