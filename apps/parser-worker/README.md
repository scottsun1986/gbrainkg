# LLMWiki parser worker

Run locally with `python3 src/main.py` or expose the FastAPI app as
`uvicorn src.main:app --host 0.0.0.0 --port 8000`.

Legacy Word `.doc` files are supported through the userland `antiword`
converter and then indexed as extracted UTF-8 text. Set `ANTIWORD_BIN` when
the converter is installed at a different path.
