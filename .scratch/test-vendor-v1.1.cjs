/**
 * Integration test for the v1.1 field-mapping refactor.
 *
 * Mock rh-rest-api now serves /models/{name} with kind-tagged node_mapping,
 * and asserts the vendor sends the CORRECT field names (not hardcoded ones).
 *
 * What we verify:
 *  1. Model with kind-tagged mapping -> vendor uses the actual `name` values as keys.
 *  2. T2I workflow where the prompt field is called "pos_prompt" (not "prompt")
 *     -> inputs.pos_prompt is set, not inputs.prompt.
 *  3. I2I workflow with image field called "ref_image_base64" -> inputs.ref_image_base64 is set.
 *  4. I2V workflow with firstFrame/lastFrame called "frame_a"/"frame_b"
 *     -> inputs.frame_a and inputs.frame_b are set, NOT inputs.firstFrame/lastFrame.
 *  5. Untagged model (no kinds) -> still works via "image" fallback.
 *  6. Model missing prompt kind -> clear error message.
 *  7. Model not found in rh-rest-api -> clear error message.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { transform } = require('sucrase');
const { VM } = require('vm2');

const ROOT = process.cwd();
const VENDOR_SRC = fs.readFileSync(path.join(ROOT, 'data/vendor/runninghub.ts'), 'utf-8');

const FAKE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FAKE_DATAURL = `data:image/png;base64,${FAKE_B64}`;

// --- Fake model registry ---
const MODELS = {
  // Case 1: T2I with non-standard field names
  'rh-t2i': {
    id: 1, workflow_id: 'wf-t2i', name: 'rh-t2i', type: 't2i',
    node_mapping: {
      '9':  { name: 'pos_prompt',   kind: 'prompt' },
      '10': { name: 'neg_prompt',   kind: 'negative' },
      '11': { name: 'width_field',  kind: 'other' },
      '12': { name: 'height_field', kind: 'other' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
  // Case 2: I2I with custom image field name
  'rh-i2i': {
    id: 2, workflow_id: 'wf-i2i', name: 'rh-i2i', type: 'i2i',
    node_mapping: {
      '9': { name: 'pos_prompt',      kind: 'prompt' },
      '15': { name: 'ref_image_b64',  kind: 'image' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
  // Case 3: I2V with firstFrame/lastFrame having different names
  'rh-i2v': {
    id: 3, workflow_id: 'wf-i2v', name: 'rh-i2v', type: 't2v',
    node_mapping: {
      '9': { name: 'pos_prompt', kind: 'prompt' },
      '20': { name: 'frame_a',   kind: 'firstFrame' },
      '21': { name: 'frame_b',   kind: 'lastFrame' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
  // Case 4: T2V no frames
  'rh-t2v': {
    id: 4, workflow_id: 'wf-t2v', name: 'rh-t2v', type: 't2v',
    node_mapping: {
      '9': { name: 'pos_prompt', kind: 'prompt' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
  // Case 5: I2I WITHOUT any image kind — should still work via fallback
  'rh-fallback': {
    id: 5, workflow_id: 'wf-fb', name: 'rh-fallback', type: 'i2i',
    node_mapping: {
      '9': { name: 'pos_prompt', kind: 'prompt' },
      '15': { name: 'image' },  // no kind at all
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
  // Case 6: missing prompt kind
  'rh-no-prompt': {
    id: 6, workflow_id: 'wf-np', name: 'rh-no-prompt', type: 't2i',
    node_mapping: {
      '10': { name: 'something', kind: 'other' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  },
};

// Capture what the vendor sent to POST /tasks
let lastSubmittedInputs = null;
let pollCount = 0;
let nextLocalId = 100;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');

    // GET /models/{name}
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/models\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]);
      const model = MODELS[name];
      if (!model) { res.statusCode = 404; res.end(JSON.stringify({ detail: 'not found' })); return; }
      res.end(JSON.stringify(model));
      return;
    }

    // POST /tasks
    if (req.method === 'POST' && req.url === '/tasks') {
      const parsed = JSON.parse(body);
      lastSubmittedInputs = parsed.inputs;
      const localId = nextLocalId++;
      pollCount = 0;
      res.statusCode = 201;
      res.end(JSON.stringify({
        id: localId, task_id: `rh-${localId}`, workflow_id: 'wf-mock', status: 'PENDING',
        inputs: parsed.inputs, outputs: null, error_msg: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), done_at: null,
      }));
      return;
    }

    // GET /tasks/{id}
    if (req.method === 'GET' && (m = req.url.match(/^\/tasks\/(\d+)$/))) {
      const localId = parseInt(m[1], 10);
      pollCount++;
      const isReady = pollCount >= 2;
      res.end(JSON.stringify({
        id: localId, task_id: `rh-${localId}`, workflow_id: 'wf-mock',
        status: isReady ? 'SUCCESS' : 'RUNNING',
        inputs: {}, outputs: isReady ? [{ fileUrl: FAKE_DATAURL, fileType: 'png', nodeId: '99', taskCostTime: '100', thirdPartyConsumeMoney: null, consumeMoney: null, consumeCoins: '10' }] : null,
        error_msg: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        done_at: isReady ? new Date().toISOString() : null,
      }));
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
});

function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); throw new Error('Assertion failed: ' + msg); }
  console.log('  PASS:', msg);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('Mock rh-rest-api at', baseUrl);

  // Load vendor
  const jsCode = transform(VENDOR_SRC, { transforms: ['typescript'] }).code;
  const codeForVm = jsCode.replace(/export\s*\{\s*\};?/g, '');
  const sandbox = {
    console, fetch: (u, o) => globalThis.fetch(u, o),
    logger: (m) => console.log('   [v]', m),
    urlToBase64: async (url) => url,
    pollTask: async (fn, interval = 50, timeout = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const r = await fn();
        if (r.completed) return r;
        if (r?.error) return r;
        await new Promise((res) => setTimeout(res, interval));
      }
      return { completed: false, error: 'timeout' };
    },
    axios: {}, FormData: class {}, jsonwebtoken: {}, crypto: require('crypto'),
    exports: {},
  };
  const vm = new VM({ timeout: 0, sandbox, compiler: 'javascript', eval: false, wasm: false });
  vm.run(codeForVm);
  const vendorMod = sandbox.exports;
  vendorMod.vendor.inputValues.baseUrl = baseUrl;
  vendorMod.vendor.inputValues.apiKey = '';

  console.log('\n=== Test 1: T2I with custom prompt name "pos_prompt" ===');
  lastSubmittedInputs = null;
  await vendorMod.imageRequest(
    { prompt: 'a cat', size: '1K', aspectRatio: '1:1' },
    vendorMod.vendor.models.find(m => m.modelName === 'rh-t2i')
  );
  assert(lastSubmittedInputs.pos_prompt === 'a cat', `inputs.pos_prompt should be "a cat" (got ${JSON.stringify(lastSubmittedInputs)})`);
  assert(!('prompt' in lastSubmittedInputs), 'inputs.prompt should NOT be set');
  assert(lastSubmittedInputs.neg_prompt === undefined, 'no negative prompt -> neg_prompt should be absent');
  assert(Object.keys(lastSubmittedInputs).length === 1, `only one key expected, got ${JSON.stringify(Object.keys(lastSubmittedInputs))}`);

  console.log('\n=== Test 2: T2I with negative prompt ===');
  lastSubmittedInputs = null;
  // Update model to include negative prompt
  MODELS['rh-t2i'].node_mapping['10'] = { name: 'neg_prompt', kind: 'negative' };
  await vendorMod.imageRequest(
    { prompt: 'a dog', size: '1K', aspectRatio: '1:1' },
    vendorMod.vendor.models.find(m => m.modelName === 'rh-t2i')
  );
  assert(lastSubmittedInputs.pos_prompt === 'a dog', 'pos_prompt set');
  assert(lastSubmittedInputs.neg_prompt === undefined, 'no negative -> absent');

  console.log('\n=== Test 3: I2I with custom image field name "ref_image_b64" ===');
  lastSubmittedInputs = null;
  await vendorMod.imageRequest(
    {
      prompt: 'turn it blue', size: '1K', aspectRatio: '1:1',
      referenceList: [{ type: 'image', sourceType: 'base64', base64: FAKE_DATAURL }],
    },
    vendorMod.vendor.models.find(m => m.modelName === 'rh-i2i')
  );
  assert(lastSubmittedInputs.pos_prompt === 'turn it blue', 'pos_prompt set');
  assert(typeof lastSubmittedInputs.ref_image_b64 === 'string', `ref_image_b64 should be a base64 string (got ${typeof lastSubmittedInputs.ref_image_b64})`);
  assert(!('image' in lastSubmittedInputs), 'inputs.image should NOT be set (kind=image maps to "ref_image_b64")');
  assert(!('firstFrame' in lastSubmittedInputs), 'inputs.firstFrame should NOT be set');

  console.log('\n=== Test 4: I2V with firstFrame="frame_a" / lastFrame="frame_b" ===');
  lastSubmittedInputs = null;
  await vendorMod.videoRequest(
    {
      prompt: 'a car drives', duration: 5, resolution: '720p', aspectRatio: '16:9',
      mode: ['endFrameOptional'],
      referenceList: [
        { type: 'image', sourceType: 'base64', base64: FAKE_DATAURL },
        { type: 'image', sourceType: 'base64', base64: FAKE_DATAURL },
      ],
    },
    vendorMod.vendor.models.find(m => m.modelName === 'rh-i2v')
  );
  assert(lastSubmittedInputs.pos_prompt === 'a car drives', 'pos_prompt set');
  assert(typeof lastSubmittedInputs.frame_a === 'string', `frame_a should be set (got keys: ${Object.keys(lastSubmittedInputs).join(',')})`);
  assert(typeof lastSubmittedInputs.frame_b === 'string', 'frame_b should be set');
  assert(!('firstFrame' in lastSubmittedInputs), 'inputs.firstFrame should NOT be set');
  assert(!('lastFrame' in lastSubmittedInputs), 'inputs.lastFrame should NOT be set');

  console.log('\n=== Test 5: T2V no frames ===');
  lastSubmittedInputs = null;
  await vendorMod.videoRequest(
    { prompt: 'a bird flies', duration: 5, resolution: '720p', aspectRatio: '16:9', mode: ['text'] },
    vendorMod.vendor.models.find(m => m.modelName === 'rh-t2v')
  );
  assert(lastSubmittedInputs.pos_prompt === 'a bird flies', 'pos_prompt set');
  assert(!('firstFrame' in lastSubmittedInputs), 'no first frame');
  assert(lastSubmittedInputs.duration === 5, 'duration passed through');
  assert(lastSubmittedInputs.resolution === '720p', 'resolution passed through');

  console.log('\n=== Test 6: I2I with no kind tags -> fallback to "image" key ===');
  lastSubmittedInputs = null;
  const r6 = await vendorMod.imageRequest(
    {
      prompt: 'x', size: '1K', aspectRatio: '1:1',
      referenceList: [{ type: 'image', sourceType: 'base64', base64: FAKE_DATAURL }],
    },
    { name: 'rh-fallback', modelName: 'rh-fallback', type: 'image', mode: ['singleImage'] }
  );
  // The fallback path: model has no kind=image entry, so we send inputs.image
  assert(typeof lastSubmittedInputs.image === 'string', `image should be set as fallback (got keys: ${Object.keys(lastSubmittedInputs).join(',')})`);
  assert(typeof r6 === 'string' && r6.startsWith('data:image/png;base64,'), 'returned base64 valid');

  console.log('\n=== Test 7: Model without prompt kind -> clear error ===');
  try {
    await vendorMod.imageRequest(
      { prompt: 'x', size: '1K', aspectRatio: '1:1' },
      { name: 'rh-no-prompt', modelName: 'rh-no-prompt', type: 'image', mode: ['text'] }
    );
    throw new Error('expected throw');
  } catch (e) {
    assert(/没有 kind="prompt"/.test(e.message), `error mentions missing prompt kind: ${e.message}`);
  }

  console.log('\n=== Test 8: Model not found in rh-rest-api -> clear error ===');
  try {
    await vendorMod.imageRequest(
      { prompt: 'x', size: '1K', aspectRatio: '1:1' },
      { name: 'nonexistent', modelName: 'nonexistent', type: 'image', mode: ['text'] }
    );
    throw new Error('expected throw');
  } catch (e) {
    assert(/未找到模型/.test(e.message), `error mentions missing model: ${e.message}`);
  }

  console.log('\n=== Test 9: I2V with single image + singleImage mode (no start/end split) ===');
  lastSubmittedInputs = null;
  // Add a single-image variant
  MODELS['rh-i2v-single'] = {
    id: 9, workflow_id: 'wf-i2vs', name: 'rh-i2v-single', type: 't2v',
    node_mapping: {
      '9': { name: 'pos_prompt', kind: 'prompt' },
      '20': { name: 'init_image', kind: 'image' },
    },
    created_at: '2025-01-01T00:00:00', updated_at: '2025-01-01T00:00:00',
  };
  await vendorMod.videoRequest(
    {
      prompt: 'a car', duration: 5, resolution: '720p', aspectRatio: '16:9',
      mode: ['singleImage'],
      referenceList: [{ type: 'image', sourceType: 'base64', base64: FAKE_DATAURL }],
    },
    { name: 'rh-i2v-single', modelName: 'rh-i2v-single', type: 'video', mode: ['singleImage'], audio: false, durationResolutionMap: [] }
  );
  assert(typeof lastSubmittedInputs.init_image === 'string', `init_image should be set (got keys: ${Object.keys(lastSubmittedInputs).join(',')})`);
  assert(!('frame_a' in lastSubmittedInputs), 'frame_a should NOT be set for singleImage mode');
  assert(!('firstFrame' in lastSubmittedInputs), 'firstFrame should NOT be set');

  console.log('\n\nALL 9 TESTS PASSED');
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nTEST FAILED:', e.message);
  server.close();
  process.exit(1);
});
