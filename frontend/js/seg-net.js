/*
 * Runs the person-segmentation network: a picture in, a mask out (1 = person, 0 = background).
 *
 * The network is MediaPipe's selfie segmenter (Apache-2.0, see frontend/vendor/README.md). Only its
 * trained weights and the list of its steps come from there, converted once by
 * scripts/segmenter-convert.py into a plain list (JSON) and the numbers (half floats). This file is
 * what runs that list: eleven kinds of step, each a call into TensorFlow.js. Nothing else of
 * MediaPipe or of TensorFlow's model loaders is needed or shipped.
 */

/** Half floats (IEEE 754 binary16), as the weights are stored, to ordinary floats. */
function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

/**
 * Loads a converted network. `tf` is TensorFlow.js (core and a backend), `graph` the JSON, `weights` an ArrayBuffer.
 * Returns { run(input) }: input is a [1, h, w, 3] tensor of 0..1 (h and w multiples of 32), the result a [h, w] tensor of 0..1.
 */
export function loadNet(tf, graph, weights) {
  const consts = new Map();        // tensor id -> tf tensor, laid out the way TensorFlow.js wants it
  const raw = (id) => {
    const c = graph.consts[id];
    const data = c.type === 'float16' ? halfToFloat(new Uint16Array(weights, c.at, c.bytes / 2)) : new Float32Array(weights.slice(c.at, c.at + c.bytes));
    return tf.tensor(data, c.shape, 'float32');
  };
  // Filters are stored [out, h, w, in]; TensorFlow.js takes [h, w, in, out] (and [h, w, out, in] for the transposed one).
  const order = { conv_2d: [1, 2, 3, 0], depthwise_conv_2d: [1, 2, 3, 0], Convolution2DTransposeBias: [1, 2, 0, 3] };
  for (const op of graph.ops) {
    if (!order[op.op]) continue;
    const [, w, b] = op.in;
    if (!consts.has(w)) consts.set(w, tf.tidy(() => tf.transpose(raw(w), order[op.op])));
    if (b !== undefined && !consts.has(b)) consts.set(b, raw(b));
  }
  const act = (x, kind) => (kind === 'relu' ? tf.relu(x) : kind === 'relu6' ? tf.relu6(x) : x);
  const steps = {
    conv_2d: (op, x) => act(tf.add(tf.conv2d(x, consts.get(op.in[1]), op.stride, op.pad, 'NHWC', op.dilation), consts.get(op.in[2])), op.act),
    depthwise_conv_2d: (op, x) => act(tf.add(tf.depthwiseConv2d(x, consts.get(op.in[1]), op.stride, op.pad, 'NHWC', op.dilation), consts.get(op.in[2])), op.act),
    hard_swish: (op, x) => tf.mul(x, tf.div(tf.relu6(tf.add(x, 3)), 6)),
    relu: (op, x) => tf.relu(x),
    logistic: (op, x) => tf.sigmoid(x),
    // Both are the average over the whole picture in this network (the pool's window is the picture).
    average_pool_2d: (op, x) => tf.mean(x, [1, 2], true),
    mean: (op, x) => tf.mean(x, [1, 2], true),
    mul: (op, x, y) => act(tf.mul(x, y), op.act),
    add: (op, x, y) => act(tf.add(x, y), op.act),
    // Always to twice the size here; taken from the shapes so a picture of another size scales the same way.
    resize_bilinear: (op, x) => { const k = graph.shapes[op.out[0]][1] / graph.shapes[op.in[0]][1]; return tf.image.resizeBilinear(x, [x.shape[1] * k, x.shape[2] * k], op.align, op.half); },
    Convolution2DTransposeBias: (op, x) => tf.add(tf.conv2dTranspose(x, consts.get(op.in[1]), [x.shape[0], x.shape[1] * op.stride[0], x.shape[2] * op.stride[1], consts.get(op.in[1]).shape[2]], op.stride, op.pad), consts.get(op.in[2])),
  };
  for (const op of graph.ops) if (!steps[op.op]) throw new Error('This network has a step this runner does not know: ' + op.op);
  // How many later steps read each value: it is thrown away after the last one.
  const uses = new Map();
  for (const op of graph.ops) for (const id of op.in) if (!graph.consts[id]) uses.set(id, (uses.get(id) || 0) + 1);

  function run(input) {
    return tf.tidy(() => {
      const val = new Map([[graph.input, input]]);
      for (const op of graph.ops) {
        const args = op.in.filter((id) => !graph.consts[id]).map((id) => val.get(id));
        val.set(op.out[0], steps[op.op](op, ...args));
      }
      const out = val.get(graph.output);
      return tf.reshape(out, [out.shape[1], out.shape[2]]);
    });
  }
  return { run, inputShape: graph.input_shape, dispose: () => { for (const t of consts.values()) t.dispose(); } };
}
