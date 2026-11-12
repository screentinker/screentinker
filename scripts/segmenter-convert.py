"""Turns a MediaPipe selfie segmentation .tflite into a plain graph (JSON) plus its weights (float16, raw).
Run once, when the model is brought in; needs `pip install tflite`. Usage: convert.py in.tflite out_prefix"""
import sys, json, struct
import tflite

def main(src, out):
    buf = open(src, 'rb').read()
    m = tflite.Model.GetRootAsModel(buf, 0); g = m.Subgraphs(0)
    opname = {v: k for k, v in tflite.BuiltinOperator.__dict__.items() if not k.startswith('_')}
    ttype = {v: k for k, v in tflite.TensorType.__dict__.items() if not k.startswith('_')}
    act = {0: None, 1: 'relu', 3: 'relu6'}
    pad = {0: 'same', 1: 'valid'}
    def opt(op, cls):
        o = cls(); t = op.BuiltinOptions(); o.Init(t.Bytes, t.Pos); return o
    blob = bytearray(); consts = {}; alias = {}
    def const(idx):
        t = g.Tensors(idx); b = m.Buffers(t.Buffer())
        if b.DataLength() == 0: return None
        raw = bytes(b.DataAsNumpy()); ty = ttype[t.Type()]
        if ty == 'INT32': return {'int': list(struct.unpack('<%di' % (len(raw) // 4), raw))}
        assert ty in ('FLOAT16', 'FLOAT32'), ty
        off = len(blob); blob.extend(raw); 
        if len(blob) % 4: blob.extend(b'\0' * (4 - len(blob) % 4))
        return {'at': off, 'bytes': len(raw), 'type': ty.lower(), 'shape': [int(x) for x in t.ShapeAsNumpy()]}
    ops = []
    for i in range(g.OperatorsLength()):
        op = g.Operators(i); oc = m.OperatorCodes(op.OpcodeIndex()); code = max(oc.BuiltinCode(), oc.DeprecatedBuiltinCode())
        name = opname[code]; ins = [int(x) for x in op.InputsAsNumpy()]; outs = [int(x) for x in op.OutputsAsNumpy()]
        if name == 'DEQUANTIZE':                       # the weights are stored as half floats: the same tensor, read as it is
            alias[outs[0]] = ins[0]; continue
        ins = [alias.get(x, x) for x in ins]
        e = {'op': name.lower(), 'in': ins, 'out': outs}
        if name == 'CONV_2D':
            o = opt(op, tflite.Conv2DOptions); e.update(pad=pad[o.Padding()], stride=[o.StrideH(), o.StrideW()], dilation=[o.DilationHFactor(), o.DilationWFactor()], act=act[o.FusedActivationFunction()])
        elif name == 'DEPTHWISE_CONV_2D':
            o = opt(op, tflite.DepthwiseConv2DOptions); e.update(pad=pad[o.Padding()], stride=[o.StrideH(), o.StrideW()], dilation=[o.DilationHFactor(), o.DilationWFactor()], act=act[o.FusedActivationFunction()], mult=o.DepthMultiplier())
        elif name == 'AVERAGE_POOL_2D':
            o = opt(op, tflite.Pool2DOptions); e.update(pad=pad[o.Padding()], stride=[o.StrideH(), o.StrideW()], size=[o.FilterHeight(), o.FilterWidth()], act=act[o.FusedActivationFunction()])
        elif name == 'MEAN':
            o = opt(op, tflite.ReducerOptions); e.update(keep=bool(o.KeepDims()))
        elif name in ('ADD', 'MUL'):
            o = opt(op, tflite.AddOptions if name == 'ADD' else tflite.MulOptions); e.update(act=act[o.FusedActivationFunction()])
        elif name == 'RESIZE_BILINEAR':
            o = opt(op, tflite.ResizeBilinearOptions); e.update(align=bool(o.AlignCorners()), half=bool(o.HalfPixelCenters()))
        elif name == 'CUSTOM':
            raw = bytes(op.CustomOptionsAsNumpy()); e['op'] = oc.CustomCode().decode()
            # TfLiteTransposeConvParams as written by MediaPipe: padding, stride_width, stride_height (three int32)
            p, sw, sh = struct.unpack('<3i', raw[:12]); e.update(custom_bytes=len(raw), pad={1: 'same', 2: 'valid'}.get(p, p), stride=[sh, sw])
        ops.append(e)
    used = sorted({x for e in ops for x in e['in']})
    for idx in used:
        c = const(idx)
        if c is not None: consts[idx] = c
    shapes = {i: [int(x) for x in g.Tensors(i).ShapeAsNumpy()] for i in sorted({x for e in ops for x in e['in'] + e['out']})}
    graph = {'input': int(g.Inputs(0)), 'output': int(g.Outputs(0)), 'input_shape': shapes[int(g.Inputs(0))], 'ops': ops, 'consts': consts, 'shapes': shapes}
    open(out + '.json', 'w').write(json.dumps(graph, separators=(',', ':')))
    open(out + '.bin', 'wb').write(bytes(blob))
    return graph, len(blob)

if __name__ == '__main__':
    gr, n = main(sys.argv[1], sys.argv[2])
    print(sys.argv[2], 'ops', len(gr['ops']), 'weights', n, 'bytes')
