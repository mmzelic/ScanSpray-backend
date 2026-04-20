// GrayMatter Robotics - PLC Backend Configuration
module.exports = {
    PLC_IP: '192.168.11.210',
    PLC_PORT: 502,
    PLC_UNIT_ID: 1,
    POLL_RATE: 100, // Speed of Modbus requests in ms

    API_PORT: 3001, // Port for the Web Server

    // Zivid 3D Camera
    ZIVID_IP: '192.168.11.105',
    ZIVID_SCRIPT: './capture_zivid.py',  // Path to the Python capture script
    ZIVID_CAPTURE_DIR: 'captures',        // Folder where images are saved (relative to server.js)
    ZIVID_PYTHON_BIN: 'C:\\Users\\roboguide\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
    ZIVID_DLL_DIR: 'C:\\Program Files\\Zivid\\bin', // Added to PATH so Python can load Zivid DLLs
};