# Arc Escrow AI

**AI-powered work validation + USDC auto-settlement on Arc Testnet**

基于 Arc Testnet 的 AI 驱动工作验证与 USDC 自动结算系统，完整实现 ERC-8183 工作生命周期。

---

## How it works / 工作原理

```
Client creates job → Funds escrow (USDC) → Provider submits deliverable
      → Claude AI evaluates → Auto settle or refund
```

1. **Create** — Client posts a job with description and budget on the Agentic Commerce contract
2. **Fund** — 5 USDC locked in escrow via `fund()`
3. **Submit** — Provider submits a `keccak256` deliverable hash on-chain
4. **Evaluate** — Claude AI reads the job description + deliverable, returns a scored verdict
5. **Settle** — `complete()` releases USDC to provider / `reject()` refunds client

---

## Tech Stack / 技术栈

| Layer | Tool |
|---|---|
| Blockchain | Arc Testnet (ERC-8183) |
| Wallet management | Circle Developer Controlled Wallets |
| Contract interaction | viem |
| AI evaluator | Anthropic Claude (claude-sonnet-4) |
| Runtime | Node.js + TypeScript |

---

## Prerequisites / 前置条件

- Node.js 18+
- Circle account → [console.circle.com](https://console.circle.com)
- Anthropic API key → [console.anthropic.com](https://console.anthropic.com)
- Testnet USDC → [faucet.circle.com](https://faucet.circle.com)

---

## Setup / 安装

```bash
npm install
cp .env.example .env
# Fill in your API keys in .env
npm start
```

---

## Environment Variables / 环境变量

```env
CIRCLE_API_KEY=        # Circle Developer Console
CIRCLE_ENTITY_SECRET=  # Circle Developer Console
ANTHROPIC_API_KEY=     # Anthropic Console
```

> ⚠️ Never commit `.env` to version control.

---

## Contract / 合约

| | Address |
|---|---|
| Agentic Commerce | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC (Arc Testnet) | `0x3600000000000000000000000000000000000000` |

[View on Arc Testnet Explorer →](https://explorer.arc.io)

---

## License

MIT

