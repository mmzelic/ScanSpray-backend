# PLC Backend — GrayMatter Robotics Paint Interface

Node.js backend that bridges the frontend HMI to a Modbus TCP PLC. Communicates over Modbus, exposes a WebSocket for real-time I/O, and logs production cycle data to CSV.

---

## Stack

| Package | Role |
|---|---|
| `express` | HTTP server + REST API |
| `socket.io` | Real-time bidirectional WebSocket |
| `modbus-serial` | Modbus TCP client |
| `csv-parser` | Read production log CSV |
| `fs` / `path` | File I/O for CSV logging |

---

## Getting Started

```bash
npm install

# Live mode (connects to PLC)
node server.js

# Simulation mode (no PLC required)
node server.js --simulation
```

Server starts on **port 3001**.

---

## Configuration

Edit [config.js](config.js):

| Key | Default | Description |
|---|---|---|
| `PLC_IP` | `192.168.11.210` | PLC IP address |
| `PLC_PORT` | `502` | Modbus TCP port |
| `PLC_UNIT_ID` | `1` | Modbus unit/slave ID |
| `POLL_RATE` | `100` | Comm loop interval (ms) |
| `API_PORT` | `3001` | HTTP/WebSocket port |

---

## Modbus Map

### Writes (Holding Registers 0–99)

| Register | Bits | Signal |
|---|---|---|
| 0 | bit 0 | Error Reset |
| 0 | bit 1 | Process Reset |
| 1 | bit 0 | Heartbeat |
| 1 | bit 9 | Gun Trigger |
| 2 | bit 0 | Mix Mode |
| 2 | bit 1 | Color Change Request |
| 3 | bit 0 | E-Stat Enable |
| 3 | bit 1 | E-Stat Error Reset |
| 3 | bit 2 | E-Stat Remote Enable |
| 10 | — | Atomizing Air Setpoint |
| 11 | — | Fan Air Setpoint |
| 12 | — | Flow Setpoint |
| 13 | — | Voltage Setpoint |
| 20 | — | Recipe Target |

### Reads (Holding Registers 200–299, mapped to buffer index 0–99)

| Register | Buffer Index | Signal |
|---|---|---|
| 200 | 0 | bit 0 = General E-Stop |
| 201 | 1 | bit 0 = Gun Trigger Status |
| 203 | 3 | bit 0 = Safe to Move, bit 1 = E-Stat Error |
| 210 | 10 | PLC Step |
| 211 | 11 | Error 0 |
| 220 | 20 | Atomizing Air Feedback |
| 221 | 21 | Fan Air Feedback |
| 222 | 22 | Flow Feedback |
| 223 | 23 | Voltage Feedback |
| 231 | 31 | Active Recipe |
| 250 | 50 | bit 1 = Robot Cycle Complete |

---

## WebSocket Events

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `initial_state` | `{ connected, readBuffer, writeBuffer, isSim }` | Sent on client connect |
| `read_update` | `number[]` (100 values) | New PLC feedback every poll cycle |
| `write_update` | `number[]` (100 values) | Updated output buffer after any write |
| `connection_status` | `boolean` | PLC connected / disconnected |

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `cmd_toggle` | `{ reg, bit }` | Toggle a single bit in the write buffer |
| `cmd_set` | `{ reg, value }` | Set an analog register value |
| `cmd_set_bit` | `{ reg, bit, value }` | Set a specific bit to 0 or 1 (used for pulses) |

> All write commands are **blocked** when the PLC is offline and simulation mode is off.

---

## REST API

### `GET /api/logs`

Returns the last 50 production cycle records from `production_logs.csv`, newest first.

```json
[
  {
    "Date": "4/17/2026",
    "StartTime": "10:32:01 AM",
    "EndTime": "10:32:45 AM",
    "Duration(s)": "44.00",
    "Program": "1",
    "Recipe": "3",
    "AtomAir": "35",
    "FanAir": "28",
    "FlowSP": "12",
    "Voltage": "60",
    "Speed": "500",
    "GunOpenTime": "2"
  }
]
```

---

## Production Logging

A cycle is detected by monitoring **Register 250, bit 1** (Robot Cycle Complete):

- **Rising edge** → record start timestamp
- **Falling edge** → calculate duration and append a row to `production_logs.csv`

The CSV is created automatically on first run with the following columns:

```
Date, StartTime, EndTime, Duration(s), Program, Recipe, AtomAir, FanAir, FlowSP, Voltage, Speed, GunOpenTime
```

---

## Simulation Mode

Start with `--simulation` to run without a physical PLC:

- Feedback registers are auto-populated with randomized values
- Write commands are accepted and echoed back
- `isConnected` is forced `true` after the first sim tick
- Recipe echo: `readBuffer[31]` mirrors `writeBuffer[20]`

---

## Startup Safety

On startup, analog registers with a defined `min` in `plcDefinitions` are pre-loaded into the write buffer before the first Modbus write. This prevents the PLC from receiving zero-valued setpoints on initial connection.
