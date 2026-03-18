const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const ModbusClient = require('modbus-serial');
const config = require('./config');
const { digital, analog } = require('../plc-frontend/src/plcDefinitions');
const csv = require('csv-parser');

const PLC_IP = config.PLC_IP;
const PLC_PORT = config.PLC_PORT;
const PLC_UNIT_ID = config.PLC_UNIT_ID;
const POLL_RATE = config.POLL_RATE;

const client = new ModbusClient();

// This checks if "--simulation" was part of the startup command
const SIMULATION_MODE = process.argv.includes('--simulation'); 
let isConnected = false;

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const fs = require('fs');
const path = require('path');



// Logging State
let cycleStartTime = null;
let lastCycleCompleteState = false; 

// Data Buffers
let readBuffer = new Array(100).fill(0);  
let lastReadBuffer = new Array(100).fill(0);

// Initialize writeBuffer with 0s, then apply minimum values from definitions
let writeBuffer = new Array(100).fill(0); 

analog.forEach(item => {
    if (item.min !== undefined) {
        writeBuffer[item.reg] = item.min;
    }
});


// CSV File Path
const logFilePath = path.join(__dirname, 'production_logs.csv');

// Create the CSV header if the file doesn't exist
if (!fs.existsSync(logFilePath)) {
    const header = "Date,StartTime,EndTime,Duration(s),Program,Recipe,AtomAir,FanAir,FlowSP,Voltage,Speed,GunOpenTime\n";
    fs.writeFileSync(logFilePath, header);
}

console.log(`[INIT] Write Buffer initialized with safety minimums.`);
// Check Flow Setpoint (Reg 12) specifically in console to verify
console.log(`[INIT] Register 12 (Flow SP) set to start at: ${writeBuffer[12]}`);

console.log(`\n=========================================`);
// Example Modbus connection block
if (!SIMULATION_MODE) {
    client.connectTCP(config.PLC_IP, { port: 502 })
        .then(() => {
            isConnected = true; // This will now match your "initial_state"
            console.log("PLC Connected Successfully");
        })
        .catch(err => {
            isConnected = false;
            console.error("PLC Connection Failed");
        });
} else {
    console.log("Running in SIMULATION MODE - Logic guards bypassed.");
    isConnected = false; // isConnected stays false, but SIMULATION_MODE is true
}
console.log(`=========================================\n`);


// --- SIGNAL NAMES (GrayMatter Style) ---
const WRITE_NAMES = {
    '0_0': 'Error Reset', '0_1': 'Process Reset',
    '1_0': 'Heartbeat', '1_9': 'Gun Trigger',
    '2_0': 'Mix Mode', '2_1': 'Color Change Req',
    '3_0': 'E-Stat Enable', '3_1': 'E-Stat Err Reset', '3_2': 'E-Stat Remote En',
    '10': 'Atomizing Air SP', '11': 'Fan Air SP', 
    '12': 'Flow SP', '13': 'Voltage SP', '20': 'Recipe Target'
};

const READ_NAMES = {
    '0_0': 'General E-Stop', '1_0': 'Gun Trigger Sts',
    '3_0': 'Safe to Move', '3_1': 'E-Stat Error',
    '10': 'PLC Step', '11': 'Error 0', '20': 'Atomizing FB', 
    '21': 'Fan FB', '22': 'Flow FB', '23': 'Voltage FB', '31': 'Active Recipe'
};

const getTime = () => new Date().toLocaleTimeString();

function processCycleLogging() {
    // 1. Extract the current state of "Robot Cycle Complete" (Reg 250, Bit 1)
    // Offset is 250 - 200 = 50 in your readBuffer logic
    const currentCycleState = ((readBuffer[50] >> 1) & 1) === 1;

    // 2. RISING EDGE: Cycle Started
    if (currentCycleState === true && lastCycleCompleteState === false) {
        cycleStartTime = new Date();
        console.log(`[${getTime()}] >>> CYCLE STARTED - Timer Initialized`);
    }

    // 3. FALLING EDGE: Cycle Finished
    if (currentCycleState === false && lastCycleCompleteState === true) {
        const endTime = new Date();
        const duration = cycleStartTime ? ((endTime - cycleStartTime) / 1000).toFixed(2) : 0;
        
        // Gather current setpoints from writeBuffer
        const logData = {
            date: endTime.toLocaleDateString(),
            start: cycleStartTime ? cycleStartTime.toLocaleTimeString() : "N/A",
            end: endTime.toLocaleTimeString(),
            duration: duration,
            prog: writeBuffer[41],
            recipe: writeBuffer[20],
            atom: writeBuffer[10],
            fan: writeBuffer[11],
            flow: writeBuffer[12],
            voltage: writeBuffer[13],
            speed: writeBuffer[40],
            gunOpen: writeBuffer[43]
        };

        saveToCSV(logData);
        cycleStartTime = null; // Reset timer
    }

    lastCycleCompleteState = currentCycleState;
}

function saveToCSV(data) {
    const row = `${data.date},${data.start},${data.end},${data.duration},${data.prog},${data.recipe},${data.atom},${data.fan},${data.flow},${data.voltage},${data.speed},${data.gunOpen}\n`;
    
    fs.appendFile(logFilePath, row, (err) => {
        if (err) console.error("Failed to save log:", err);
        else console.log(`[${getTime()}] LOGGED: Cycle complete (${data.duration}s). Saved to production_logs.csv`);
    });
}

// --- SIMULATION ENGINE ---
function runSimulation() {
    // Fake a heartbeat toggle
    readBuffer[10] = (readBuffer[10] + 1) % 100; // Increment PLC Step
    
    // Randomly fluctuate feedback values slightly
    readBuffer[20] = 40 + Math.floor(Math.random() * 5); // Atomizing Air
    readBuffer[21] = 30 + Math.floor(Math.random() * 3); // Fan Air
    
    // Echo the recipe
    readBuffer[31] = writeBuffer[20]; 

    io.emit('read_update', readBuffer);
    if (!isConnected) {
        isConnected = true;
        io.emit('connection_status', true);
    }

    processCycleLogging();
}

// --- HELPER FUNCTION ---
function getWriteName(reg, bit = null) {
    if (bit !== null) {
        // Search the digital array for a match
        const match = digital.find(t => t.reg === reg && t.bit === bit);
        return match ? match.name : `Register ${reg} Bit ${bit}`;
    }
    // Search the analog array for a match
    const match = analog.find(i => i.reg === reg);
    return match ? match.name : `Register ${reg}`;
}

// --- MODBUS LOOP ---
async function commLoop() {
    if (SIMULATION_MODE) {
        runSimulation();
    } else {
        try {
            if (!client.isOpen) {
                await client.connectTCP(PLC_IP, { port: PLC_PORT });
                client.setID(PLC_UNIT_ID);
                client.setTimeout(2000);
                console.log(`[${getTime()}] Connected to Hardware PLC at ${PLC_IP}`);
            }

            // Sync Buffers
            await client.writeRegisters(0, writeBuffer);
            await new Promise(r => setTimeout(r, 50));
            const res = await client.readHoldingRegisters(200, 100);
            
            readBuffer = res.data;
            processCycleLogging();
            io.emit('read_update', readBuffer);
            
            if (!isConnected) {
                isConnected = true;
                io.emit('connection_status', true);
            }
        } catch (err) {
            if (isConnected) console.log(`[${getTime()}] PLC Disconnected: ${err.message}`);
            isConnected = false;
            io.emit('connection_status', false);
            try { client.close(); } catch(e) {}
        }
    }
    setTimeout(commLoop, POLL_RATE);
}

commLoop();

// --- WEBSOCKET EVENT LISTENERS ---
io.on('connection', (socket) => {
    socket.emit('initial_state', {
        connected: isConnected,
        readBuffer: readBuffer,
        writeBuffer: writeBuffer,
        isSim: SIMULATION_MODE
    });

    // Handle Toggles
    socket.on('cmd_toggle', ({ reg, bit }) => {
        // GUARD: Allow if we have a real connection OR if the --simulation flag is active
        if (!isConnected && !SIMULATION_MODE) {
            console.warn(`[REJECTED] Write blocked: PLC Offline and Simulation Mode is OFF`);
            return; 
        }

        // Toggle the bit in the buffer
        writeBuffer[reg] ^= (1 << bit);
        
        // Log the action
        console.log(`[WRITE] Reg ${reg} Bit ${bit} -> ${((writeBuffer[reg] >> bit) & 1)} ${SIMULATION_MODE ? '(SIM)' : ''}`);
        
        io.emit('write_update', writeBuffer);
    });

    // Handle Setpoints
    socket.on('cmd_set', ({ reg, value }) => {
        // GUARD: Same check for analog setpoints
        if (!isConnected && !SIMULATION_MODE) return;

        writeBuffer[reg] = value;
        console.log(`[WRITE] Reg ${reg} Value ${value} ${SIMULATION_MODE ? '(SIM)' : ''}`);
        
        io.emit('write_update', writeBuffer);
    });

    socket.on('cmd_set_bit', ({ reg, bit, value }) => {
        // ADD THIS GUARD HERE TOO
    if (!isConnected && !SIMULATION_MODE) return;

    if (value === 1) {
        writeBuffer[reg] |= (1 << bit); 
    } else {
        writeBuffer[reg] &= ~(1 << bit); 
    }
        
        const signalName = getWriteName(reg, bit);
        console.log(`[${getTime()}] [PULSE] -> ${signalName} set to ${value === 1 ? 'HIGH' : 'LOW'}`);
        
        io.emit('write_update', writeBuffer);
    });
});

const PORT = 3001;

// API to get logs
app.get('/api/logs', (req, res) => {
    const results = [];
    if (!fs.existsSync(logFilePath)) {
        return res.json([]); // Return empty if no file yet
    }

    fs.createReadStream(logFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            // Send the last 50 logs so the page isn't too heavy
            res.json(results.reverse().slice(0, 50));
        });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ===========================================
    GRAYMATTER ROBOTICS - PLC INTERFACE
    Backend: Active on Port ${PORT}
    Mode: ${SIMULATION_MODE ? 'SIMULATION' : 'LIVE'}
    ===========================================
    `);
});