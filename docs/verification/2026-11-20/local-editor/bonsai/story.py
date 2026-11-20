from pathlib import Path
from mlx_lm import load, generate
model, tokenizer = load("prism-ml/Bonsai-4B-mlx-1bit")
prompt = tokenizer.apply_chat_template([{"role":"user","content":"Write a story about Einstein"}],add_generation_prompt=True)
text = generate(model, tokenizer, prompt=prompt, verbose=True, max_tokens=256)
Path(__file__).with_name("bonsai-answer.txt").write_text(text)
