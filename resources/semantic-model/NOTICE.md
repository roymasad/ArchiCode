# Bundled semantic models

ArchiCode bundles `BAAI/bge-small-en-v1.5` at revision
`c5ac6c397e27c80e0229ec647987f2e553fc0ba9` as the higher-quality default.

- Source: https://huggingface.co/BAAI/bge-small-en-v1.5
- License: MIT

ArchiCode bundles `Xenova/all-MiniLM-L6-v2` at revision
`751bff37182d3f1213fa05d7196b954e230abad9` for local feature extraction.

- Source: https://huggingface.co/Xenova/all-MiniLM-L6-v2
- Base model: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- License: Apache License 2.0

Both models run locally. Their generated per-project vector indexes are disposable
machine-local caches and are not stored in user repositories.
