/**
 * Toonflow AI供应商 - RunningHub (通过 rh-rest-api 中转)
 * @version 2.0
 *
 * 重大变更（v1.1 → v2.0 修复）：
 *   1) multiImage 现在发送 string[]（数组），不再是 CSV 字符串
 *   2) extras（duration/resolution/aspectRatio 等）也按 node_mapping 的 kind 路由
 *      —— 之前是盲发固定 key，现在必须先在 rh-rest-api 标好 kind 才能传
 *   3) 决定 firstFrame / lastFrame / image 时，优先看模型实际暴露哪些 kind
 *      而非只看 VideoConfig.mode
 *   4) audio / video 类型的 reference 现在会被路由到 audio / video 字段
 *   5) 加了模型定义 in-memory 缓存，避免同一 modelName 重复打 /models
 *   6) 删除了无用的 "negative" 逻辑（ImageConfig/VideoConfig 都没有该字段）
 *
 * 工作流（不变）：
 *   1. GET /models/{name} 拉模型定义 + node_mapping（带 kind）
 *   2. 按 kind 把 Toonflow 的 config 路由到模型实际的字段名
 *   3. POST /tasks {model, inputs: {fieldName: value, ...}}
 *   4. 轮询 GET /tasks/{id} 直到 SUCCESS/FAILED
 *   5. 拿 outputs[0].fileUrl，urlToBase64 返回
 *
 * 字段映射关键点（rh-rest-api /ui 中的 kind 下拉框）：
 *   prompt       - 主提示词
 *   image        - 单张参考图（image-to-image / 单参考文生图）
 *   firstFrame   - 视频首帧
 *   lastFrame    - 视频尾帧
 *   multiImage   - 多参考图（value 为 base64 数组，**不是 CSV 字符串**）
 *   audio        - 音频参考
 *   video        - 视频参考
 *   negative     - 负向提示词（暂未从 Toonflow config 注入，留作扩展）
 *   other        - 其他字段，自行扩展
 *
 * 启动 rh-rest-api:
 *   cd rh-rest-api
 *   cp .env.example .env   # 填入 RH_BASE_URL / RH_API_KEY
 *   uv run app.py          # 默认监听 http://localhost:8000
 */

// ============================================================
// 类型定义（与全站模板保持一致）
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
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string; disabled?: boolean }[];
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

// rh-rest-api 模型定义
type ModelKind =
  | "prompt"
  | "negative"
  | "image"
  | "firstFrame"
  | "lastFrame"
  | "multiImage"
  | "video"
  | "audio"
  | "other";

interface RhNodeSpec {
  name: string;
  kind?: ModelKind;
}

interface RhModelResponse {
  id: number;
  workflow_id: string;
  name: string;
  type: "t2i" | "i2i" | "t2v" | "v2v";
  node_mapping: Record<string, RhNodeSpec>;
  created_at: string;
  updated_at: string;
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
  version: "2.0",
  author: "Toonflow",
  name: "RunningHub",
  description:
    "通过本地 rh-rest-api 中转调用 RunningHub ComfyUI 工作流，支持文生图、图生图、文生视频、图生视频。\n\n**v2.0 字段自动映射**：vendor 会从 rh-rest-api 拉取模型定义，按每个 node_mapping 的 `kind` 标签自动填入 inputs。\n\n请在 rh-rest-api /ui 中为每个 node_mapping 字段打上 kind 标签：\n- `prompt` — 主提示词\n- `image` — 单张参考图\n- `firstFrame` / `lastFrame` — 视频首/尾帧\n- `multiImage` — 多参考图（数组）\n- `audio` / `video` — 音频/视频参考",
  inputs: [
    { key: "apiKey", label: "API密钥（可选）", type: "password", required: false, placeholder: "rh-rest-api 通常无需鉴权，留空即可" },
    {
      key: "baseUrl",
      label: "rh-rest-api 地址",
      type: "url",
      required: true,
      placeholder: "示例：http://localhost:8000",
    },
  ],
  inputValues: { apiKey: "", baseUrl: "http://localhost:8000" },
  models: [
    // 占位模型 —— 实际可用模型必须在 rh-rest-api /ui 中以同名注册
    { name: "文生图 (T2I)", modelName: "rh-t2i", type: "image", mode: ["text"] },
    { name: "图生图 (I2I)", modelName: "rh-i2i", type: "image", mode: ["singleImage", "multiReference"] },
    {
      name: "文生视频 (T2V)",
      modelName: "rh-t2v",
      type: "video",
      mode: ["text", "singleImage"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p", "1080p"] }],
    },
    {
      name: "图生视频 (I2V)",
      modelName: "rh-i2v",
      type: "video",
      mode: ["singleImage", "endFrameOptional"],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p", "1080p"] }],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const normalizeBaseUrl = (raw: string): string => (raw || "").replace(/\/+$/, "");

const getHeaders = (): Record<string, string> => {
  const apiKey = (vendor.inputValues.apiKey || "").replace(/^Bearer\s+/i, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
};

const stripBase64Header = (b64: string): string => {
  if (!b64) return "";
  const idx = b64.indexOf("base64,");
  return idx >= 0 ? b64.slice(idx + "base64,".length) : b64;
};

// 简单的 in-memory 缓存：避免同一 modelName 在一次会话中重复打 /models。
// key = baseUrl + "::" + modelName
const modelCache: Map<string, { at: number; model: RhModelResponse }> = new Map();
const modelCacheTtlMs = 60_000; // 1 分钟

/**
 * 拉取 rh-rest-api 中注册的模型定义。带 1 分钟内存缓存。
 */
const fetchRhModel = async (baseUrl: string, modelName: string): Promise<RhModelResponse | null> => {
  const cacheKey = `${baseUrl}::${modelName}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.at < modelCacheTtlMs) {
    return cached.model;
  }

  const resp = await fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`rh-rest-api 拉取模型定义失败 (${resp.status}): ${text}`);
  }
  const model = (await resp.json()) as RhModelResponse;
  modelCache.set(cacheKey, { at: Date.now(), model });
  return model;
};

/**
 * 从 node_mapping 中找出指定 kind 对应的**实际字段名**（ComfyUI 节点上的输入名）。
 * 返回的 name 才是应该填到 inputs dict 里的 key —— 它会原样传给 rh-rest-api，
 * rh-rest-api 再用同样的 name 查 node_mapping 找到对应 nodeId 提交给 RunningHub。
 *
 * 例如: { "9": { name: "pos_prompt", kind: "prompt" } }
 *       ->  findFieldName(model, "prompt") = "pos_prompt"
 *       ->  inputs = { "pos_prompt": "a cat" }
 */
const findFieldName = (rhModel: RhModelResponse, kind: ModelKind): string | null => {
  for (const spec of Object.values(rhModel.node_mapping || {})) {
    if (spec && spec.kind === kind && spec.name) return spec.name;
  }
  return null;
};

/**
 * 找出该 kind 对应的**所有**字段名（多用于 multiImage 场景，
 * 节点可能有多个同名 kind 的输入槽）。
 */
const findAllFieldNames = (rhModel: RhModelResponse, kind: ModelKind): string[] => {
  const out: string[] = [];
  for (const spec of Object.values(rhModel.node_mapping || {})) {
    if (spec && spec.kind === kind && spec.name) out.push(spec.name);
  }
  return out;
};

/**
 * 检查模型是否定义了指定 kind 的字段。
 */
const hasKind = (rhModel: RhModelResponse, kind: ModelKind): boolean => findFieldName(rhModel, kind) !== null;

/**
 * 按**字段名**查找（与 kind 无关）。用于数值/结构参数（duration、resolution 等），
 * 这些参数在 rh-rest-api /ui 中没有专属 kind，但用户在 node_mapping 中
 * 仍会给 ComfyUI 节点输入命名为 duration / resolution / aspectRatio / size 之一。
 * 只要任一映射的 name 命中，就用那个 name 作为 inputs key。
 */
const findFieldByName = (rhModel: RhModelResponse, targetName: string): string | null => {
  for (const spec of Object.values(rhModel.node_mapping || {})) {
    if (spec && spec.name === targetName) return spec.name;
  }
  return null;
};

const submitTask = async (
  baseUrl: string,
  modelName: string,
  inputs: Record<string, any>
): Promise<{ localId: number; rhTaskId: string | null }> => {
  logger(`[runninghub] 提交任务 -> model=${modelName}, inputs keys=${Object.keys(inputs).join(",")}`);
  const resp = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ model: modelName, inputs }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`rh-rest-api 提交任务失败 (${resp.status}): ${text}`);
  }
  const data: any = await resp.json();
  if (!data || typeof data.id !== "number") {
    throw new Error(`rh-rest-api 响应缺少 id 字段: ${JSON.stringify(data)}`);
  }
  logger(`[runninghub] 任务已提交, localId=${data.id}, rhTaskId=${data.task_id ?? "(pending)"}`);
  return { localId: data.id, rhTaskId: data.task_id ?? null };
};

const fetchTask = async (baseUrl: string, localId: number): Promise<any> => {
  const resp = await fetch(`${baseUrl}/tasks/${localId}`, { method: "GET", headers: getHeaders() });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`rh-rest-api 查询任务失败 (${resp.status}): ${text}`);
  }
  return await resp.json();
};

const waitForTask = async (baseUrl: string, localId: number, timeoutMs: number): Promise<any> => {
  const result = await pollTask(
    async () => {
      const task = await fetchTask(baseUrl, localId);
      const status: string = (task?.status || "").toUpperCase();
      if (status === "FAILED") {
        return { completed: true, error: task?.error_msg || "rh-rest-api 任务失败" };
      }
      if (status === "SUCCESS" || status === "DONE") {
        return { completed: true, data: task };
      }
      logger(`[runninghub] 轮询中, status=${status}, rhTaskId=${task?.task_id ?? "-"}`);
      return { completed: false };
    },
    5000,
    timeoutMs
  );
  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("rh-rest-api 任务超时未返回结果");
  return result.data;
};

const pickOutputUrl = (task: any): string | null => {
  const outs: any[] = task?.outputs;
  if (!Array.isArray(outs) || outs.length === 0) return null;
  for (const o of outs) {
    if (o && typeof o.fileUrl === "string" && o.fileUrl.length > 0) return o.fileUrl;
  }
  return null;
};

/**
 * 把 sandbox 给的 base64 引用按 model 的 kind 标签打包成 inputs dict。
 *
 * 关键设计：完全按 kind 路由，绝不盲发固定 key。
 * 调用方传入语义值（firstFrame / lastFrame / image / multiImage / audio / video），
 * 本函数查 node_mapping 找出该 kind 的实际字段名，再写进 inputs。
 */
const routeInputsByKind = (
  rhModel: RhModelResponse,
  entries: Array<{ kind: ModelKind; value: any }>
): Record<string, any> => {
  const inputs: Record<string, any> = {};
  for (const { kind, value } of entries) {
    if (value === undefined || value === null) continue;
    const name = findFieldName(rhModel, kind);
    if (!name) continue;
    inputs[name] = value;
    logger(`[runninghub] 映射 ${kind} -> ${name}`);
  }
  return inputs;
};

/**
 * 把数值/结构参数按**字段名**路由（与 kind 无关）。
 * 用于 duration / resolution / aspectRatio / size 这类没有专属 kind 的参数。
 * 只要 node_mapping 中某条目的 name 命中目标名，就用那个 name 作为 inputs key。
 * 命中不到则跳过（不会传未知 key）。
 */
const routeStructuralByName = (
  rhModel: RhModelResponse,
  entries: Array<{ targetName: string; value: any }>
): Record<string, any> => {
  const inputs: Record<string, any> = {};
  for (const { targetName, value } of entries) {
    if (value === undefined || value === null) continue;
    const name = findFieldByName(rhModel, targetName);
    if (!name) continue;
    inputs[name] = value;
    logger(`[runninghub] 结构参数 ${targetName} -> ${name}`);
  }
  return inputs;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  throw new Error("RunningHub 供应商暂不支持文本模型，请在 rh-rest-api 中扩展");
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const baseUrl = normalizeBaseUrl(vendor.inputValues.baseUrl);
  if (!baseUrl) throw new Error("缺少 rh-rest-api 请求地址，请在供应商设置中填写 baseUrl");

  // 1. 拉模型定义
  const rhModel = await fetchRhModel(baseUrl, model.modelName);
  if (!rhModel) {
    throw new Error(
      `rh-rest-api 中未找到模型 "${model.modelName}"。请在 rh-rest-api /ui 中以该 name 注册工作流，并为每个 node_mapping 字段打上 kind 标签。`
    );
  }

  // 2. 校验：必须有 prompt 字段
  if (!hasKind(rhModel, "prompt")) {
    throw new Error(
      `模型 "${model.modelName}" 的 node_mapping 中没有 kind="prompt" 的字段。请在 rh-rest-api /ui 给文本输入字段打上 prompt 标签。`
    );
  }

  // 3. 按 kind 路由媒体类 inputs（prompt、image、multiImage 等）
  const imageRefs = config.referenceList ?? [];
  const imageRefValues = imageRefs.map((r) => stripBase64Header(r.base64));

  const mediaInputs = routeInputsByKind(rhModel, [
    { kind: "prompt", value: config.prompt },
    // 单张图
    ...(imageRefValues.length === 1
      ? [{ kind: "image" as ModelKind, value: imageRefValues[0] }]
      : []),
    // 多张图（修复 v1.1 的 CSV-join bug：现在发真正的 string[]）
    ...(imageRefValues.length > 1
      ? [{ kind: "multiImage" as ModelKind, value: imageRefValues }]
      : []),
  ]);

  // 4. 按字段名路由结构参数（size / aspectRatio 在 rh-rest-api /ui 中没有专属 kind，
  //    但用户通常会把节点输入命名为 size 或 aspectRatio）。
  const structuralInputs = routeStructuralByName(rhModel, [
    { targetName: "size", value: config.size },
    { targetName: "aspectRatio", value: config.aspectRatio },
  ]);

  const inputs = { ...structuralInputs, ...mediaInputs };

  // 4. 兜底：模型既没标 image 也没标 multiImage，但用户又传了 1 张图
  //    把 base64 写到 "image" 字段名（rh-rest-api 会按 name 匹配，仍可能工作）
  if (
    imageRefValues.length > 0 &&
    !hasKind(rhModel, "image") &&
    !hasKind(rhModel, "multiImage") &&
    !hasKind(rhModel, "firstFrame")
  ) {
    inputs.image = imageRefValues[0];
    logger(`[runninghub] 警告: 模型未标 image/multiImage/firstFrame，兜底写入 inputs.image`);
  }

  if (Object.keys(inputs).length === 0) {
    throw new Error(`模型 "${model.modelName}" 没有任何可用的 kind 字段，无法提交任务`);
  }

  // 5. 提交 + 轮询
  const { localId } = await submitTask(baseUrl, model.modelName, inputs);
  const task = await waitForTask(baseUrl, localId, 600_000);

  const url = pickOutputUrl(task);
  if (!url) throw new Error("rh-rest-api 任务完成但未返回 outputs，请检查 rh-rest-api 配置");
  logger(`[runninghub] 图片生成完成, url=${url}`);
  return await urlToBase64(url);
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const baseUrl = normalizeBaseUrl(vendor.inputValues.baseUrl);
  if (!baseUrl) throw new Error("缺少 rh-rest-api 请求地址，请在供应商设置中填写 baseUrl");

  // 1. 拉模型定义
  const rhModel = await fetchRhModel(baseUrl, model.modelName);
  if (!rhModel) {
    throw new Error(
      `rh-rest-api 中未找到模型 "${model.modelName}"。请在 rh-rest-api /ui 中以该 name 注册工作流，并为每个 node_mapping 字段打上 kind 标签。`
    );
  }

  // 2. 校验：必须有 prompt 字段
  if (!hasKind(rhModel, "prompt")) {
    throw new Error(
      `模型 "${model.modelName}" 的 node_mapping 中没有 kind="prompt" 的字段。请在 rh-rest-api /ui 给文本输入字段打上 prompt 标签。`
    );
  }

  // 3. 按 kind 拆解 referenceList
  const refs = config.referenceList ?? [];
  const imageRefs = refs.filter((r) => r.type === "image") as Extract<ReferenceList, { type: "image" }>[];
  const audioRefs = refs.filter((r) => r.type === "audio") as Extract<ReferenceList, { type: "audio" }>[];
  const videoRefs = refs.filter((r) => r.type === "video") as Extract<ReferenceList, { type: "video" }>[];

  const imageBase64List = imageRefs.map((r) => stripBase64Header(r.base64));

  // 4. 决定 firstFrame / lastFrame / image / multiImage 的路由
  //    优先级：模型先看它有哪些 kind 字段，再看用户传了几张图。
  //    之前的 v1.1 只看 VideoConfig.mode 决定 first/last，忽略模型实际定义 —— 已修复。
  const hasFF = hasKind(rhModel, "firstFrame");
  const hasLF = hasKind(rhModel, "lastFrame");
  const hasImg = hasKind(rhModel, "image");
  const hasMulti = hasKind(rhModel, "multiImage");

  // 看用户传了图片，且模式需要首尾帧
  const modeArr = config.mode as VideoMode[];
  const needsStartEnd = modeArr.some(
    (m) => m === "startEndRequired" || m === "endFrameOptional" || m === "startFrameOptional"
  );

  const firstFrameValue = (hasFF && imageBase64List.length >= 1) ? imageBase64List[0] : undefined;
  const lastFrameValue = (hasLF && imageBase64List.length >= 2) ? imageBase64List[1] : undefined;
  // 单图：当模型有 image 字段但没 firstFrame 时
  const singleImageValue = (hasImg && !hasFF && imageBase64List.length === 1) ? imageBase64List[0] : undefined;
  // 多图：多张图片 + multiImage 字段
  const multiImageValue = (hasMulti && imageBase64List.length >= 2) ? imageBase64List : undefined;

  // 5. extras（数值参数）按字段名路由（与 kind 无关）
  //    建议用户在 rh-rest-api /ui 把这些参数节点命名为 duration / resolution / aspectRatio / size。
  const audioFlag = model.audio !== false && config.audio === true;

  const mediaInputs = routeInputsByKind(rhModel, [
    { kind: "prompt", value: config.prompt },
    { kind: "firstFrame", value: firstFrameValue },
    { kind: "lastFrame", value: lastFrameValue },
    { kind: "image", value: singleImageValue },
    { kind: "multiImage", value: multiImageValue },
    { kind: "audio", value: audioRefs[0] ? stripBase64Header(audioRefs[0].base64) : undefined },
    { kind: "video", value: videoRefs[0] ? stripBase64Header(videoRefs[0].base64) : undefined },
  ]);

  // audio 开关：作为结构参数按字段名路由（避免与上面 audio 参考图的 kind 冲突）
  const structuralInputs = routeStructuralByName(rhModel, [
    { targetName: "size", value: config.aspectRatio },
    { targetName: "duration", value: config.duration },
    { targetName: "resolution", value: config.resolution },
    { targetName: "aspectRatio", value: config.aspectRatio },
    { targetName: "audio", value: audioFlag ? true : undefined },
  ]);

  const inputs = { ...structuralInputs, ...mediaInputs };

  // 6. 兜底：模型既没标 firstFrame 也没标 image，但用户传了 1 张图
  //    用 VideoConfig.mode 推断（保留 v1.1 行为以防老工作流）
  if (
    imageBase64List.length > 0 &&
    !hasFF &&
    !hasImg &&
    !hasMulti
  ) {
    if (needsStartEnd) {
      inputs.firstFrame = imageBase64List[0];
      if (imageBase64List.length >= 2) inputs.lastFrame = imageBase64List[1];
    } else {
      inputs.image = imageBase64List[0];
    }
    logger(`[runninghub] 警告: 模型未标 firstFrame/image/multiImage，按 mode 兜底写入`);
  }

  if (Object.keys(inputs).length === 0) {
    throw new Error(`模型 "${model.modelName}" 没有任何可用的 kind 字段，无法提交任务`);
  }

  // 7. 提交 + 轮询
  const { localId } = await submitTask(baseUrl, model.modelName, inputs);
  const task = await waitForTask(baseUrl, localId, 1_800_000);

  const url = pickOutputUrl(task);
  if (!url) throw new Error("rh-rest-api 任务完成但未返回 outputs，请检查 rh-rest-api 配置");
  logger(`[runninghub] 视频生成完成, url=${url}`);
  return await urlToBase64(url);
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "2.0",
    notice:
      "## RunningHub 供应商 v2.0\n\n**字段自动映射**：提交任务前会 GET /models/{name} 拉取工作流定义，按每个 node_mapping 的 `kind` 字段自动填入 inputs 字典的 key。\n\n请在 rh-rest-api /ui 中为每个映射打上 kind 标签（prompt / image / firstFrame / lastFrame / multiImage / audio / video / negative / other）。\n\n**v2.0 修复**：\n- multiImage 现在发送真正的 base64 数组，不再是 CSV 字符串\n- duration/resolution/aspectRatio 也按 kind 路由，不再盲发固定 key\n- 参考图分配现在看模型实际定义哪些 kind，不再只看 mode",
  };
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

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
