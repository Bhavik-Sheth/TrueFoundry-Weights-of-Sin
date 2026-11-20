from pathlib import Path
import json, numpy as np, mlx.core as mx
d=next((Path.home()/'.cache/huggingface/hub/models--prism-ml--Bonsai-4B-mlx-1bit/snapshots').iterdir())
out=Path(__file__).with_name('bonsai-compatible');out.mkdir(exist_ok=True)
for p in d.iterdir():
 if p.name not in ('config.json','model.safetensors','model.safetensors.index.json') and not (out/p.name).exists(): (out/p.name).symlink_to(p)
cfg=json.loads((d/'config.json').read_text());cfg['quantization']['bits']=2;(out/'config.json').write_text(json.dumps(cfg))
w=mx.load(str(d/'model.safetensors'));count=0
for k in list(w):
 if not k.endswith('.weight') or k[:-7]+'.scales' not in w: continue
 a=np.asarray(w[k]); assert a.dtype==np.uint32
 halves=a.view(np.uint16).astype(np.uint32)
 x=halves.copy()
 for shift,mask in ((8,0x00ff00ff),(4,0x0f0f0f0f),(2,0x33333333),(1,0x55555555)):
  x=(x|(x<<shift))&mask
 for bit in range(16):assert np.array_equal((x>>(2*bit))&3,(halves>>bit)&1)
 w[k]=mx.array(x);count+=1
mx.save_safetensors(str(out/'model.safetensors'),w);print(count,'packed weight tensors checked bit-for-bit')
