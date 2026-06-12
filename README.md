# MiMo Auto Free Proxy

Cloudflare Worker proxy for MiMo Auto (free) API.

JWT 池自动管理：请求时自动获取 JWT 并存入 KV，池满（30个）后不再获取，随机取用，失效自动剔除。

## Setup

1. Create KV namespace: `wrangler kv namespace create MIMO_JWT_KV`
2. Update `wrangler.toml` with your KV namespace ID
3. Deploy: `wrangler deploy`

## Endpoints

| Method | Path                   | Description                                  |
| ------ | ---------------------- | -------------------------------------------- |
| POST   | `/v1/chat/completions` | OpenAI-compatible chat (stream + tool_calls) |
| GET    | `/v1/models`           | List available models                        |
| GET    | `/admin/pool`          | Check pool status                            |

## Usage

```python
from openai import OpenAI
client = OpenAI(base_url="https://mimo-free-proxy.<your-subdomain>.workers.dev/v1", api_key="anonymous")
```
