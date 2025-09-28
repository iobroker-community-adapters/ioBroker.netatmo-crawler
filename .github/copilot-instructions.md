# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context
- **Adapter Name**: netatmo-crawler
- **Primary Function**: Crawls information from public Netatmo weather stations
- **Target Service**: Netatmo Weather API (public weather station data)
- **Data Types**: Temperature, humidity, rain, pressure, wind speed, wind gust strength
- **Connection Type**: HTTP requests to Netatmo's public weather map API
- **Schedule Mode**: Runs on schedule (*/5 * * * * - every 5 minutes)
- **Key Dependencies**: request library for HTTP calls, moment for timestamp handling
- **Configuration**: Multiple station URLs, station naming preferences (counter vs station ID)

### Netatmo-Specific Context
- Works with public weather stations from the Netatmo weather map (weathermap.netatmo.com)  
- Extracts weather data like temperature, humidity, rain measurements, atmospheric pressure, wind data
- Handles authentication tokens for Netatmo API access
- Processes station URLs in format: https://weathermap.netatmo.com/...
- Creates read-only states for all weather measurements
- Implements proper timestamp tracking for last data retrieval and measurement updates
- Handles both real-time and historical rain data (rain vs rain_lastHour)

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check if basic states were created
                        const states = await harness.getExistingStatesAsync('your-adapter.0.*');
                        console.log(`States found: ${Object.keys(states).length}`);
                        
                        if (Object.keys(states).length > 0) {
                            console.log('✅ Adapter created states successfully');
                            resolve();
                        } else {
                            reject(new Error('No states created by adapter'));
                        }
                    } catch (error) {
                        console.error('❌ Test failed:', error);
                        reject(error);
                    }
                });
            }).timeout(30000); // 30 second timeout
        });
    }
});
```

#### Integration Test Guidelines

1. **Always use `tests.integration()` function** - This is the official method
2. **Use `defineAdditionalTests` for custom scenarios** - Don't override the default tests
3. **Access harness through `getHarness()` callback** - Essential for proper test isolation
4. **Configure adapter through harness methods** - Use `changeAdapterConfig()` or direct object manipulation
5. **Wait appropriately for async operations** - Allow time for adapter startup and data processing
6. **Check state creation as success indicator** - Verify adapter actually performed its function
7. **Use reasonable timeouts** - 30+ seconds for integration tests with external APIs

#### Testing External API Integrations
For adapters that connect to external services:

```javascript
it('should handle API connectivity', async function() {
    this.timeout(60000); // Longer timeout for API calls
    
    const testConfig = {
        apiEndpoint: 'https://api.example.com',
        refreshInterval: 300000,
        // Test-specific configuration
    };
    
    await harness.changeAdapterConfig('your-adapter', {
        native: testConfig
    });
    
    await harness.startAdapterAndWait();
    
    // Wait for API calls to complete
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Verify connection state
    const connectionState = await harness.getStateAsync('your-adapter.0.info.connection');
    expect(connectionState).to.have.property('val');
    
    // Verify data states were created
    const dataStates = await harness.getExistingStatesAsync('your-adapter.0.data.*');
    expect(Object.keys(dataStates).length).to.be.greaterThan(0);
});
```

## Configuration Management

### JSON Config (admin/jsonConfig.json)
Use the modern JSON Config system for adapter configuration:

```json
{
  "type": "panel",
  "items": {
    "stationUrls": {
      "type": "text",
      "label": "Station URLs",
      "help": "Enter Netatmo station URLs (from weathermap.netatmo.com)",
      "placeholder": "https://weathermap.netatmo.com/...",
      "newLine": true
    },
    "stationNameType": {
      "type": "select",
      "label": "Station naming",
      "options": [
        {"value": "counter", "label": "Use counter (station1, station2, ...)"},
        {"value": "id", "label": "Use station ID"}
      ]
    }
  }
}
```

### Configuration Validation
Always validate configuration in the adapter:

```javascript
// In onReady() method
if (!this.config.stationUrls) {
    this.log.error('No station URLs configured');
    return;
}

const regex = /(https:\/\/weathermap\.netatmo\.com\/{1,}[-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
const stationUrls = this.config.stationUrls.match(regex) || [];

if (!stationUrls.length) {
    this.log.warn(`No valid station URLs detected at ${this.config.stationUrls}`);
    return;
}
```

## ioBroker Adapter Patterns

### Adapter Structure
```javascript
class YourAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'your-adapter',
        });
        
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Initialize adapter
        this.log.info('Starting adapter');
        
        // Set connection status to false initially
        await this.setStateAsync('info.connection', false, true);
        
        try {
            // Your adapter logic here
            await this.mainLoop();
            
            // Set connection status to true on success
            await this.setStateAsync('info.connection', true, true);
            
        } catch (error) {
            this.log.error(`Adapter initialization failed: ${error}`);
            await this.setStateAsync('info.connection', false, true);
        }
        
        // Schedule termination for schedule mode adapters
        this.terminate ? this.terminate('Adapter finished', 0) : process.exit(0);
    }

    onUnload(callback) {
        try {
            // Clean up resources
            this.log.info('Cleaning up...');
            callback();
        } catch (e) {
            callback();
        }
    }
}
```

### State Management
```javascript
// Create states with proper ACL (read-only for measurements)
await this.createOwnState('temperature', '°C', 'number', 'value.temperature');

// Set states with acknowledgment flag
await this.setStateAsync('temperature', { val: 23.5, ack: true });

// Create state helper method
async createOwnState(stateName, unit, type, role) {
    const obj = {
        type: 'state',
        common: {
            name: stateName,
            type: type,
            role: role,
            read: true,
            write: false, // Read-only for sensor data
            unit: unit,
        },
        native: {},
    };
    
    await this.setObjectNotExistsAsync(stateName, obj);
}
```

### Error Handling
```javascript
// Implement comprehensive error handling
try {
    const response = await this.makeApiCall();
    await this.processResponse(response);
} catch (error) {
    if (error.code === 'ENOTFOUND') {
        this.log.error('Network error: Unable to resolve hostname');
    } else if (error.statusCode === 401) {
        this.log.error('Authentication failed - check credentials');
    } else if (error.statusCode >= 500) {
        this.log.warn('Server error - will retry later');
    } else {
        this.log.error(`Unexpected error: ${error.message}`);
    }
    
    // Set connection to false on error
    await this.setStateAsync('info.connection', false, true);
}
```

### Logging Best Practices
```javascript
// Use appropriate log levels
this.log.debug('Detailed debug information');           // Development only
this.log.info('Important user information');           // Key status updates
this.log.warn('Warning - something unexpected happened'); // Recoverable issues
this.log.error('Error - operation failed');            // Actual errors

// Include context in log messages
this.log.info(`Processing station ${id} with ${dataPoints} data points`);
this.log.error(`Failed to connect to station ${id}: ${error.message}`);
```

### Cleanup and Resource Management
```javascript
onUnload(callback) {
  try {
    // Clear any timers
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    
    // Clear intervals
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    
    // Close connections
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    
    // Close connections, clean up resources
    callback();
  } catch (e) {
    callback();
  }
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

### Netatmo-Specific Code Patterns
```javascript
// Pattern for extracting station ID from URL
getStationId(url) {
    const matches = url.match(/station=([^&]+)/);
    return matches ? matches[1] : null;
}

// Pattern for processing Netatmo weather data
async saveStationData(stationId, data) {
    const measurements = ['temperature', 'humidity', 'pressure', 'rain'];
    
    for (const measurement of measurements) {
        if (data[measurement] !== undefined) {
            await this.saveMeasure(stationId, measurement, data[measurement]);
        }
    }
    
    // Save timestamp when data was last updated
    await this.saveTimestamp(stationId, 'lastUpdate', Date.now());
}

// Pattern for authentication token handling  
async getAuthorizationToken(adapter) {
    try {
        // Implement token caching to avoid excessive API calls
        if (this.cachedToken && this.tokenExpiry > Date.now()) {
            return this.cachedToken;
        }
        
        const response = await this.requestToken();
        this.cachedToken = response.access_token;
        this.tokenExpiry = Date.now() + (response.expires_in * 1000);
        
        return this.cachedToken;
    } catch (error) {
        adapter.log.error(`Token authentication failed: ${error.message}`);
        throw error;
    }
}
```

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

### Netatmo-Specific Testing Patterns
For the netatmo-crawler adapter, consider these specific test scenarios:

```javascript
// Test station URL parsing and validation
it('should validate and parse station URLs correctly', () => {
    const validUrls = [
        'https://weathermap.netatmo.com/?zoom=18&type=temp&params=Filter&station=70%3Aee%3A50%3A3a%3A4c%3A14',
        'https://weathermap.netatmo.com/zoom=16&type=temp&params=Filter&station=70%3Aee%3A50%3A47%3A30%3A98'
    ];
    
    const regex = /(https:\/\/weathermap\.netatmo\.com\/{1,}[-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
    
    validUrls.forEach(url => {
        const matches = url.match(regex);
        expect(matches).to.not.be.null;
        expect(matches[0]).to.equal(url);
    });
});

// Test weather data processing
it('should process weather station data correctly', async () => {
    const mockWeatherData = {
        temperature: 23.5,
        humidity: 65,
        pressure: 1013.25,
        rain: 0.2,
        wind_strength: 5.2,
        gust_strength: 8.1
    };
    
    // Test data processing logic
    await adapter.saveStationData(1, mockWeatherData);
    
    // Verify states were created with correct values
    const tempState = await adapter.getStateAsync('station1.temperature');
    expect(tempState.val).to.equal(23.5);
    expect(tempState.ack).to.be.true;
});
```