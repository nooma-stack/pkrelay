# PKRelay Remote Developer Setup

Connect your local Chrome browser to Claude Code sessions running on a remote machine (e.g., a shared Mac Studio).

## Prerequisites

- PKRelay extension installed in Chrome on your laptop
- PKRelay broker running on your laptop (auto-starts when extension loads)
- SSH access to the remote machine with key-based auth

## How It Works

Your laptop runs the PKRelay broker daemon (port 18793). An SSH reverse tunnel forwards a port on the remote machine back to your laptop's broker. Claude Code on the remote machine connects to the tunneled port as a PKRelay client.

```
Your laptop:   Chrome extension <-> PKRelay broker (localhost:18793)
                                         ^
                                    SSH tunnel
                                         ^
Remote machine: Claude Code -> pkrelay client -> localhost:<YOUR_PORT>
```

## Step 1: Choose Your Port

Each developer on the shared machine needs a unique port. Coordinate with your team:

| Developer | Port |
|-----------|------|
| Dev 1 | 18793 |
| Dev 2 | 18794 |
| Dev 3 | 18795 |
| Dev 4 | 18796 |

## Step 2: SSH Config

Add to your `~/.ssh/config` on your laptop:

```
Host mac-studio
  HostName <IP_OR_HOSTNAME>
  User <YOUR_USERNAME>
  RemoteForward <YOUR_PORT> localhost:18793
```

Example:
```
Host mac-studio
  HostName 192.168.1.50
  User patrick
  RemoteForward 18794 localhost:18793
```

The tunnel activates automatically when you SSH in.

## Step 3: Claude Code Config

On the remote machine, edit your `~/.claude.json` and update the pkrelay MCP entry:

```json
{
  "mcpServers": {
    "pkrelay": {
      "type": "stdio",
      "command": "pkrelay",
      "env": {
        "PKRELAY_BROKER": "ws://localhost:<YOUR_PORT>/mcp-client"
      }
    }
  }
}
```

Example for port 18794:
```json
{
  "mcpServers": {
    "pkrelay": {
      "type": "stdio",
      "command": "pkrelay",
      "env": {
        "PKRELAY_BROKER": "ws://localhost:18794/mcp-client"
      }
    }
  }
}
```

## Step 4: Test

1. SSH into the remote machine (tunnel activates)
2. Start a Claude Code session
3. PKRelay tools should connect through the tunnel to your laptop's Chrome

## Automated Setup (Extension UI)

Instead of manual SSH config, you can use PKRelay's Remote Sessions settings:

1. Open PKRelay extension settings in Chrome
2. Scroll to "Remote Sessions"
3. Enter: alias, hostname, username, SSH password, port
4. Click "Setup & Connect"

This generates SSH keys, installs them on the remote, and starts the tunnel automatically. See the extension settings page for details.

## Troubleshooting

**"Not connected to broker"**
- Verify broker is running on your laptop: `lsof -iTCP:18793 -sTCP:LISTEN`
- If not, reload PKRelay extension or run: `pkrelay --daemon`

**"Cannot connect to broker at ws://localhost:PORT"**
- Verify SSH tunnel is active: `ssh -O check mac-studio` or check `lsof -iTCP:<YOUR_PORT> -sTCP:LISTEN` on the remote
- If tunnel died, reconnect SSH

**Port conflict on remote**
- Another dev may be using your port. Choose a different one and update both SSH config and .claude.json.
