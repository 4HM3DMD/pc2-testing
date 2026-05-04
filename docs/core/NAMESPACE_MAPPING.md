# PC2 v1 -> Runtime v2 Namespace Mapping

> **Version:** 1.0
> **Created:** 2026-03-23
> **Status:** Reference document for Runtime v2 migration planning

---

## Overview

Rong Chen's architecture defines a `localhost://` namespace where humans and AI agents are peer actors. This document maps PC2 v1.x filesystem paths to their Runtime v2 `localhost://` equivalents, ensuring that no breaking changes are needed during migration.

**Key principle:** We do NOT change any v1.x paths. This document only records the mapping. Runtime v2 will translate paths at the namespace layer.

---

## Path Mapping Table

### User Space

| PC2 v1 Path | Runtime v2 Namespace | Description |
|-------------|---------------------|-------------|
| `~/Desktop/` | `localhost://Users/{user}/Desktop/` | User desktop files |
| `~/Documents/` | `localhost://Users/{user}/Documents/` | User documents |
| `~/Downloads/` | `localhost://Users/{user}/Downloads/` | User downloads |
| `~/Pictures/` | `localhost://Users/{user}/Pictures/` | User media |
| `~/pc2/personal/` | `localhost://Users/{user}/Personal/` | Default agent workspace (personal assistant) |

### AI Agent Space

| PC2 v1 Path | Runtime v2 Namespace | Description |
|-------------|---------------------|-------------|
| `~/pc2/agents/{agentId}/` | `localhost://UsersAI/{agentName}/` | Agent workspace root |
| `~/pc2/agents/{agentId}/MEMORY.md` | `localhost://UsersAI/{agentName}/MEMORY.md` | Agent long-term memory |
| `~/pc2/agents/{agentId}/SOUL.md` | `localhost://UsersAI/{agentName}/SOUL.md` | Agent personality/soul |
| `~/pc2/agents/{agentId}/notes/` | `localhost://UsersAI/{agentName}/Notes/` | Agent daily notes |
| `~/pc2/skills/{skillId}/SKILL.md` | `localhost://UsersAI/Skills/{skillId}/SKILL.md` | User-installed skills |

### System Space

| PC2 v1 Path | Runtime v2 Namespace | Description |
|-------------|---------------------|-------------|
| `pc2-node/data/test-apps/{appName}/` | `localhost://AppCapsules/{appName}/` | Installed applications |
| `pc2-node/data/skills/{skillId}/` | `localhost://AppCapsules/Skills/{skillId}/` | Bundled skills (system-level) |
| `pc2-node/data/db/pc2.db` | `localhost://System/Database/` | System database |
| `pc2-node/data/ipfs/` | `localhost://System/IPFS/` | IPFS node data |

### Public/Shared Space

| PC2 v1 Path | Runtime v2 Namespace | Description |
|-------------|---------------------|-------------|
| User-uploaded public files | `localhost://Public/` | Publicly accessible content |
| IPFS-pinned content (by CID) | `localhost://IPFS/{cid}` | Content-addressable storage |

---

## Implementation Details

### Agent Workspace Convention (v1.x)

Agents are created with workspace paths following this pattern:

```
~/pc2/agents/{agentId}/
```

The default personal assistant uses:

```
~/pc2/personal/
```

See `GatewayService.ts` line 955:

```typescript
workspace: agentData.workspace || existing?.workspace || `~/pc2/agents/${agentId}`,
```

### Files Within Agent Workspace

Each agent workspace contains:

- `MEMORY.md` — Long-term curated knowledge (managed by `AgentMemoryManager`)
- `SOUL.md` — Agent personality and system prompt customization
- `notes/YYYY-MM-DD.md` — Daily conversation notes

### Skills Paths

- **Bundled skills** (ship with PC2): `pc2-node/data/skills/{skillId}/SKILL.md`
- **User-installed skills**: `~/pc2/skills/{skillId}/SKILL.md`

The skill loader in `ChannelBridge.ts` checks bundled first, then user filesystem.

---

## Migration Strategy

### What does NOT change in v1.x

- No filesystem paths are renamed or moved
- No directory structures are reorganized
- Agent workspaces remain at `~/pc2/agents/{agentId}/`
- Skills remain at their current paths

### What Runtime v2 adds

- A namespace translation layer maps v1 paths to `localhost://` URIs
- Capability tokens scope access to specific namespace paths
- The `localhost://UsersAI/` namespace treats agents as first-class citizens alongside `localhost://Users/`
- Content-addressable paths (`localhost://IPFS/{cid}`) replace file-path-based access for verified content

### Questions for Anders

1. Is `localhost://UsersAI/` a fixed namespace path or dynamically provisioned per node?
2. Does the namespace layer handle path translation transparently, or do capsules need to use `localhost://` URIs directly?
3. How does `localhost://AppCapsules/` handle versioning — does each version get its own sub-path?

---

## Naming Conventions

To ensure smooth mapping, PC2 v1.x follows these conventions:

- **Agent IDs**: Lowercase alphanumeric with hyphens (e.g., `personal`, `trading-bot`, `content-curator`)
- **Skill IDs**: Lowercase with hyphens matching the directory name (e.g., `wallet-ops`, `file-management`)
- **App names**: Lowercase with hyphens matching `app.json` `name` field (e.g., `elacity-market`, `ddrm-viewer`)

These conventions ensure clean 1:1 mapping to `localhost://` namespace paths without character escaping or normalization.

---

*This document is maintained alongside the ROADMAP.md and STRATEGIC_IMPLEMENTATION_PLAN.md as part of the Runtime v2 convergence preparation.*
