const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const ModbusClient = require('modbus-serial');
const { spawn } = require('child_process');
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
let lastCapturedImageFile = '';

// Zivid State
let lastZividSnapshotState = null; // null = uninitialized; seeded on first read to avoid spurious trigger
let captureInProgress = false;
let pendingImageTestNumber = null; // Set when cycle ends while capture is still running

// Zivid Daemon (persistent process — connects to camera once, accepts CAPTURE commands)
let zividDaemon = null;
let daemonReady = false;
let daemonOutputBuffer = '';

// Captures folder
const captureDir = path.join(__dirname, config.ZIVID_CAPTURE_DIR || 'captures');
if (!fs.existsSync(captureDir)) {
    fs.mkdirSync(captureDir, { recursive: true });
}

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

const CSV_HEADER = "TestNumber,Date,StartTime,EndTime,Duration(s),Program,Recipe,AtomAir,FanAir,FlowSP,Voltage,Speed,GunOpenTime,Humidity,Temperature,ImageFile";

// Create or migrate the CSV
let testCounter = 1;

if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, CSV_HEADER + '\n');
} else {
    const lines = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(l => l.trim() !== '');
    const currentCols = (lines[0] || '').split(',');
    const expectedCols = CSV_HEADER.split(',');
    const missingCols = expectedCols.filter(c => !currentCols.includes(c));

    if (missingCols.length > 0) {
        console.log(`[INIT] CSV missing columns: ${missingCols.join(', ')} — migrating...`);
        const newLines = [CSV_HEADER];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const oldCols = lines[i].split(',');
            // Remap each expected column from its old position; auto-fill missing ones
            const newRow = expectedCols.map((col, colIdx) => {
                const oldIdx = currentCols.indexOf(col);
                if (oldIdx >= 0) return oldCols[oldIdx] || '';
                if (col === 'TestNumber') return String(i); // sequential number for old rows
                return '';
            });
            newLines.push(newRow.join(','));
        }
        fs.writeFileSync(logFilePath, newLines.join('\n') + '\n');
        console.log(`[INIT] CSV migration complete.`);
        // Re-read after rewrite
        const reread = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(l => l.trim() !== '');
        testCounter = reread.length; // header + data rows, next = length
    } else {
        testCounter = lines.length;
    }
}
console.log(`[INIT] Next test number: ${testCounter}`);

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
            testNumber: testCounter,
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
            gunOpen: writeBuffer[43],
            humidity: readBuffer[60],    // addr 260 → buf index 60
            temperature: readBuffer[61], // addr 261 → buf index 61
            imageFile: lastCapturedImageFile
        };

        saveToCSV(logData);
        // If capture is still running, mark this test for retroactive image update
        if (captureInProgress && !lastCapturedImageFile) {
            pendingImageTestNumber = logData.testNumber;
            console.log(`[${getTime()}] [ZIVID] Capture still in progress — will update Test #${logData.testNumber} when done`);
        }
        testCounter++;
        cycleStartTime = null;
        lastCapturedImageFile = '';
    }

    lastCycleCompleteState = currentCycleState;
}

function saveToCSV(data) {
    const row = `${data.testNumber},${data.date},${data.start},${data.end},${data.duration},${data.prog},${data.recipe},${data.atom},${data.fan},${data.flow},${data.voltage},${data.speed},${data.gunOpen},${data.humidity},${data.temperature},${data.imageFile || ''}\n`;
    
    fs.appendFile(logFilePath, row, (err) => {
        if (err) console.error("Failed to save log:", err);
        else console.log(`[${getTime()}] LOGGED: Cycle complete (${data.duration}s). Saved to production_logs.csv`);
    });
}

function updateCSVImageFile(testNumber, imageFile) {
    try {
        const content = fs.readFileSync(logFilePath, 'utf8');
        const lines = content.split('\n');
        const headerCols = lines[0].split(',');
        const testIdx = headerCols.indexOf('TestNumber');
        const imgIdx  = headerCols.indexOf('ImageFile');
        if (testIdx === -1 || imgIdx === -1) return;

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const cols = lines[i].split(',');
            if (cols[testIdx]?.trim() === String(testNumber)) {
                cols[imgIdx] = imageFile;
                lines[i] = cols.join(',');
                break;
            }
        }
        fs.writeFileSync(logFilePath, lines.join('\n'));
        console.log(`[${getTime()}] [ZIVID] Test #${testNumber} updated with image: ${imageFile}`);
    } catch (err) {
        console.error(`[${getTime()}] [ZIVID] CSV update failed: ${err.message}`);
    }
}

// --- ZIVID DAEMON ---
function handleDaemonLine(line) {
    if (!line) return;

    if (line === 'READY') {
        daemonReady = true;
        console.log(`[${getTime()}] [ZIVID] Daemon READY — camera connected`);
        return;
    }

    if (line === 'CONNECTING') {
        console.log(`[${getTime()}] [ZIVID] Daemon connecting to camera...`);
        return;
    }

    if (line.startsWith('SAVED:')) {
        const savedPath = line.slice(6);
        const fileName = path.basename(savedPath);
        captureInProgress = false;
        console.log(`[${getTime()}] [ZIVID] Capture SUCCESS → ${fileName}`);

        if (pendingImageTestNumber !== null) {
            updateCSVImageFile(pendingImageTestNumber, fileName);
            pendingImageTestNumber = null;
        } else {
            lastCapturedImageFile = fileName;
        }
        writeBuffer[42] |= (1 << 7);
        io.emit('write_update', [...writeBuffer]);
        return;
    }

    if (line.startsWith('ERROR:')) {
        captureInProgress = false;
        pendingImageTestNumber = null;
        console.error(`[${getTime()}] [ZIVID] Capture ERROR: ${line.slice(6)}`);
        return;
    }

    console.log(`[ZIVID] ${line}`);
}

function startZividDaemon() {
    if (zividDaemon) return;

    console.log(`[${getTime()}] [ZIVID] Starting persistent daemon...`);
    const spawnEnv = { ...process.env };
    if (config.ZIVID_DLL_DIR) {
        spawnEnv.PATH = `${config.ZIVID_DLL_DIR};${spawnEnv.PATH || ''}`;
    }

    zividDaemon = spawn(config.ZIVID_PYTHON_BIN || 'python', [
        path.join(__dirname, 'capture_zivid_daemon.py'),
        config.ZIVID_IP
    ], { env: spawnEnv });

    daemonOutputBuffer = '';

    zividDaemon.stdout.on('data', (chunk) => {
        daemonOutputBuffer += chunk.toString();
        const lines = daemonOutputBuffer.split('\n');
        daemonOutputBuffer = lines.pop(); // keep incomplete last line
        for (const line of lines) {
            handleDaemonLine(line.trim());
        }
    });

    zividDaemon.stderr.on('data', (d) => {
        console.error(`[ZIVID] ERR: ${d.toString().trim()}`);
    });

    zividDaemon.on('error', (err) => {
        console.error(`[${getTime()}] [ZIVID] Daemon process error: ${err.message}`);
        zividDaemon = null;
        daemonReady = false;
    });

    zividDaemon.on('close', (code) => {
        console.log(`[${getTime()}] [ZIVID] Daemon exited (code ${code})`);
        zividDaemon = null;
        daemonReady = false;
        captureInProgress = false;
    });
}

function triggerZividCapture() {
    if (captureInProgress) {
        console.warn(`[${getTime()}] [ZIVID] Capture already in progress, ignoring trigger`);
        return;
    }
    if (!daemonReady) {
        console.warn(`[${getTime()}] [ZIVID] Daemon not ready — capture skipped`);
        return;
    }

    captureInProgress = true;

    const now = new Date();
    const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
    const prog = writeBuffer[41];
    const recipe = writeBuffer[20];
    const fileName = `capture_${ts}_prog${prog}_recipe${recipe}.png`;
    const filePath = path.join(captureDir, fileName);

    console.log(`[${getTime()}] [ZIVID] Triggering capture → ${fileName}`);
    zividDaemon.stdin.write(`CAPTURE ${filePath}\n`);
}

function processZividCapture() {
    // addr 250 → readBuffer index 50, bit 3
    const currentState = ((readBuffer[50] >> 3) & 1) === 1;

    // Seed on first read — prevents spurious trigger if bit is already HIGH at startup
    if (lastZividSnapshotState === null) {
        lastZividSnapshotState = currentState;
        return;
    }

    // Rising edge: trigger capture
    if (currentState && !lastZividSnapshotState) {
        triggerZividCapture();
    }

    // Falling edge: clear the Image Captured feedback bit
    if (!currentState && lastZividSnapshotState) {
        writeBuffer[42] &= ~(1 << 7);
        io.emit('write_update', [...writeBuffer]);
    }

    lastZividSnapshotState = currentState;
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
    processZividCapture();
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
        setTimeout(commLoop, POLL_RATE); // Continue loop
        return;
    }

    try {
        // 1. Connection Guard
        if (!client.isOpen) {
            isConnected = false;
            io.emit('connection_status', false);
            
            console.log(`[${getTime()}] Attempting to reach PLC at ${PLC_IP}...`);
            await client.connectTCP(PLC_IP, { port: PLC_PORT });
            client.setID(PLC_UNIT_ID);
            client.setTimeout(2000);
            console.log(`[${getTime()}] Connected to Hardware PLC.`);
        }

        // 2. Double-Check Open state before writing
        if (client.isOpen) {
            // Write Setpoints
            await client.writeRegisters(0, writeBuffer);
            
            // Small pause between Write and Read to prevent collision
            await new Promise(r => setTimeout(r, 50));
            
            // Read Feedback
            const res = await client.readHoldingRegisters(200, 100);
            
            readBuffer = res.data;
            processCycleLogging();
            processZividCapture();
            io.emit('read_update', readBuffer);
            
            if (!isConnected) {
                isConnected = true;
                io.emit('connection_status', true);
            }
        }
        
        // Success: Continue at normal POLL_RATE
        setTimeout(commLoop, POLL_RATE);

    } catch (err) {
        // 3. Graceful Error Handling
        if (isConnected) {
            console.error(`[${getTime()}] PLC Comm Error: ${err.message}`);
        }
        
        isConnected = false;
        io.emit('connection_status', false);

        // Force close the broken socket so we can start fresh
        try { 
            client.close(); 
        } catch(e) {
            // Ignore close errors
        }

        // 4. IMPORTANT: Wait longer on error (5s) before retrying 
        // This prevents the "Write After End" crash
        console.log(`[${getTime()}] Retrying in 5 seconds...`);
        setTimeout(commLoop, 5000); 
    }
}

commLoop();
startZividDaemon();

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

// Serve captured images
app.get('/captures/:filename', (req, res) => {
    const filePath = path.join(captureDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        console.warn(`[CAPTURES] File not found: ${filePath}`);
        res.status(404).json({ error: 'Image not found', path: filePath });
    }
});

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