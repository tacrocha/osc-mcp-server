# Testing Guide

This guide explains how to test the OSC MCP server with an X-Air family mixer (Behringer XR12, XR16, XR18; Midas MR18).

## Overview

The server is designed for X-Air mixers only. To test:

1. **Connect your X-Air mixer** to the same network as your computer.
2. **Enable OSC** on the mixer (if required by your model).
3. **Configure the MCP server** with the mixer's IP and port 10024.

## Configuration

Edit your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add or update the configuration:

```json
{
  "mcpServers": {
    "osc": {
      "command": "node",
      "args": [
        "/path/to/osc-mcp/dist/index.js"
      ],
      "env": {
        "OSC_HOST": "192.168.1.70",
        "OSC_PORT": "10024"
      }
    }
  }
}
```

Replace `OSC_HOST` with your X-Air mixer's IP address. Use port **10024** for X-Air.

## Running Tests

Run the connection test script to verify connectivity:

```bash
npm test
```

This will attempt to connect to the X-Air mixer at the configured address and perform basic operations. Ensure the mixer is powered on and on the same network.

## Manual Testing

Once connected, use Claude Desktop (or another MCP client) to control the mixer. Try commands like:

- "Set channel 1 fader to 75%"
- "Mute channel 3"
- "Pan channel 2 to the left"
- "What's the mixer status?"

Verify that changes are reflected on the mixer or in the X-Air edit app if you use it for monitoring.
