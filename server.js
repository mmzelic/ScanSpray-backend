const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const ModbusClient = require('modbus-serial');

const PLC_IP = '192.168.11.210';
const PLC_PORT = 502;
const PLC_UNIT_ID = 1;
const POLL_RATE = 1000; 

const app = express();
app.use(cors());

// Wrap Express with HTTP to attach Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const client = new ModbusClient();
let isConnected = false;

let writeBuffer = new Array(100).fill(0); 
let readBuffer = new Array(100).fill(0);  
let lastReadBuffer = new Array(100).fill(0);

// --- SIGNAL DICTIONARIES ---
const WRITE_NAMES = {
    '0_0': 'Error Reset', '0_1': 'Process Reset',
    '1_0': 'Heartbeat', '1_9': 'Gun Trigger',
    '2_0': 'Mix Mode', '2_1': 'Color Change Req',
    '3_0': 'E-Stat Enable', '3_1': 'E-Stat Err Reset', '3_2': 'E-Stat Remote En',
    '10': 'Atomizing Air Setpoint', '11': 'Fan Air Setpoint', 
    '12': 'Flow Setpoint', '13': 'Voltage Setpoint', '20': 'Recipe Target'
};

const READ_NAMES = {
    '0_0': 'General E-Stop', '1_0': 'Gun Trigger Sts',
    '3_0': 'Safe to Move', '3_1': 'E-Stat Error',
    '10': 'PLC Step', 
    '11': 'Error 0', '12': 'Error 1', '13': 'Error 2', '14': 'Error 3', '15': 'Error 4',
    '20': 'Atomizing Air FB', '21': 'Fan Air FB', 
    '22': '2KS Flow FB', '23': 'Voltage FB',
    '30': 'Recipe Echo', '31': 'Active Recipe'
};

const getTime = () => new Date().toLocaleTimeString();

process.on('uncaughtException', function(err) {
    console.error(`[${getTime()}] [FATAL] TCP Socket Error:`, err.message);
    setConnectionStatus(false);
    try { client.close(); } catch(e) {}
});

// Helper to broadcast connection status
function setConnectionStatus(status) {
    if (isConnected !== status) {
        isConnected = status;
        io.emit('connection_status', isConnected); // Push to all clients instantly
    }
}

// --- PLC STATE CHANGE DETECTOR ---
function checkAndLogChanges(oldBuf, newBuf) {
    let hasChanged = false;
    for (let i = 0; i < 100; i++) {
        if (oldBuf[i] !== newBuf[i]) {
            hasChanged = true;
            const oldVal = oldBuf[i];
            const newVal = newBuf[i];

            if (READ_NAMES[`${i}`]) {
                console.log(`[${getTime()}] [PLC STATUS]  -> ${READ_NAMES[`${i}`]} changed: ${oldVal} to ${newVal}`);
            } 
            
            for (let bit = 0; bit < 16; bit++) {
                const bitName = READ_NAMES[`${i}_${bit}`];
                if (bitName) {
                    const oldBit = (oldVal >> bit) & 1;
                    const newBit = (newVal >> bit) & 1;
                    if (oldBit !== newBit) {
                        console.log(`[${getTime()}] [PLC STATUS]  -> ${bitName} flipped to ${newBit ? 'ON' : 'OFF'}`);
                    }
                }
            }
        }
    }
    return hasChanged;
}

// --- Modbus Polling Loop ---
async function commLoop() {
    try {
        if (!isConnected) {
            try { client.close(); } catch(e) {}
            await new Promise(resolve => setTimeout(resolve, 500)); 

            await client.connectTCP(PLC_IP, { port: PLC_PORT });
            client.setID(PLC_UNIT_ID);
            client.setTimeout(2500); 
            
            setConnectionStatus(true);
            console.log(`\n=========================================`);
            console.log(`[${getTime()}] [SYSTEM] CONNECTED TO PLC`);
            console.log(`=========================================\n`);
        }

        if (isConnected) {
            await client.writeRegisters(0, writeBuffer);
            await new Promise(resolve => setTimeout(resolve, 50)); 
            
            const readRes = await client.readHoldingRegisters(200, 100);
            
            // If PLC changed, instantly broadcast to all React clients
            const changed = checkAndLogChanges(lastReadBuffer, readRes.data);
            if (changed) {
                readBuffer = readRes.data;
                io.emit('read_update', readBuffer);
            }
            lastReadBuffer = [...readRes.data]; 
        }

    } catch (err) {
        if (isConnected) {
            console.log(`\n[${getTime()}] [SYSTEM] CONNECTION LOST: ${err.message}\n`);
        }
        setConnectionStatus(false);
        try { client.close(); } catch(e) {}
    }

    setTimeout(commLoop, POLL_RATE);
}

commLoop();

// --- WEBSOCKET EVENT LISTENERS ---
io.on('connection', (socket) => {
    console.log(`[${getTime()}] [WEB] New tablet/browser connected.`);
    
    // Instantly send full current state to the new client
    socket.emit('initial_state', {
        connected: isConnected,
        readBuffer: readBuffer,
        writeBuffer: writeBuffer
    });

    // Listen for Toggle commands from React
    socket.on('cmd_toggle', ({ reg, bit }) => {
        if (reg >= 0 && reg < 100 && bit >= 0 && bit <= 15) {
            writeBuffer[reg] ^= (1 << bit); 
            const newState = (writeBuffer[reg] >> bit) & 1;
            const name = WRITE_NAMES[`${reg}_${bit}`] || `Reg [${reg}] Bit [${bit}]`;
            
            console.log(`[${getTime()}] [USER CMD] -> ${name} toggled to ${newState ? 'ON' : 'OFF'}`);
            io.emit('write_update', writeBuffer); // Update all screens so they sync
        }
    });

    // Listen for Set commands from React
    socket.on('cmd_set', ({ reg, value }) => {
        const valInt = parseInt(value, 10);
        if (reg >= 0 && reg < 100 && valInt >= 0 && valInt <= 65535) {
            const oldVal = writeBuffer[reg];
            writeBuffer[reg] = valInt;
            const name = WRITE_NAMES[`${reg}`] || `Reg [${reg}]`;
            
            console.log(`[${getTime()}] [USER CMD] -> ${name} changed from ${oldVal} to ${valInt}`);
            io.emit('write_update', writeBuffer); // Sync all screens
        }
    });
});

const PORT = 3001;
// Notice we start 'server', not 'app', to include WebSockets
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend API & WebSockets running on port ${PORT}`);
});