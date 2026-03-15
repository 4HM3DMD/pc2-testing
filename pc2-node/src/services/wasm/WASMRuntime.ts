/**
 * WASM Runtime Service
 * Executes WASM binaries locally on PC2 node
 * Completely self-contained - no external dependencies
 * 
 * Features:
 * - Concurrency control (max parallel executions)
 * - Execution timeout
 * - Memory limit enforcement
 */

import { logger } from '../../utils/logger.js';
import { init, WASI, MemFS } from '@wasmer/wasi';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

export interface WASMExecutionResult {
    success: boolean;
    result?: any;
    error?: string;
    executionTimeMs?: number;
}

export interface RendererCommand {
    cek_b64: string;
    iv_b64: string;
    mime_type: string;
    watermark?: string;
    page?: number;
    max_width?: number;
    max_height?: number;
    output_format?: 'jpeg' | 'webp' | 'png';
}

export interface RendererResult {
    success: boolean;
    error?: string;
    content_type?: string;
    total_pages?: number;
    output_size?: number;
}

export interface RendererOutput {
    result: RendererResult;
    renderedBytes: Buffer | null;
    executionTimeMs: number;
}

export interface WASMExecutionOptions {
    timeoutMs?: number;      // Execution timeout (default: 30000ms)
    maxMemoryMb?: number;    // Max memory for this execution (default: 512MB)
    inputFiles?: Record<string, string>;  // Map of realPath -> wasiPath for WASI file access
}

export interface WASMRuntimeConfig {
    maxConcurrent?: number;  // Max concurrent executions (default: 4)
    defaultTimeoutMs?: number;  // Default timeout (default: 30000)
    defaultMaxMemoryMb?: number;  // Default memory limit (default: 512)
}

interface QueuedExecution {
    resolve: () => void;
    reject: (error: Error) => void;
}

export class WASMRuntime {
    private memFs: MemFS | null = null;
    private initialized: boolean = false;
    
    // Throttling state
    private activeExecutions: number = 0;
    private maxConcurrent: number;
    private defaultTimeoutMs: number;
    private defaultMaxMemoryMb: number;
    private executionQueue: QueuedExecution[] = [];

    constructor(config?: WASMRuntimeConfig) {
        this.maxConcurrent = config?.maxConcurrent ?? 4;
        this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 30000;
        this.defaultMaxMemoryMb = config?.defaultMaxMemoryMb ?? 512;
    }

    /**
     * Update runtime configuration dynamically
     */
    updateConfig(config: Partial<WASMRuntimeConfig>): void {
        if (config.maxConcurrent !== undefined) {
            this.maxConcurrent = config.maxConcurrent;
            logger.info(`[WASMRuntime] Max concurrent updated to: ${this.maxConcurrent}`);
        }
        if (config.defaultTimeoutMs !== undefined) {
            this.defaultTimeoutMs = config.defaultTimeoutMs;
            logger.info(`[WASMRuntime] Default timeout updated to: ${this.defaultTimeoutMs}ms`);
        }
        if (config.defaultMaxMemoryMb !== undefined) {
            this.defaultMaxMemoryMb = config.defaultMaxMemoryMb;
            logger.info(`[WASMRuntime] Default max memory updated to: ${this.defaultMaxMemoryMb}MB`);
        }
        
        // Process queue in case we increased capacity
        this.processQueue();
    }

    /**
     * Get current runtime stats
     */
    getStats(): { activeExecutions: number; queueLength: number; maxConcurrent: number } {
        return {
            activeExecutions: this.activeExecutions,
            queueLength: this.executionQueue.length,
            maxConcurrent: this.maxConcurrent,
        };
    }

    /**
     * Initialize WASMER runtime
     * Must be called before executing WASM binaries
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            await init();
            // Create MemFS after initialization
            this.memFs = new MemFS();
            this.initialized = true;
            logger.info('[WASMRuntime] Initialized successfully');
        } catch (error: any) {
            logger.error('[WASMRuntime] Initialization failed:', error);
            throw new Error(`Failed to initialize WASMER runtime: ${error.message}`);
        }
    }

    /**
     * Prepare a file for WASI access by copying it to MemFS
     * This allows WASI modules to read files from the real filesystem
     * @param realPath - Path to the real file on the host filesystem
     * @param wasiPath - Path where the file will be accessible in WASI (e.g., '/input.txt')
     */
    async prepareFileForWASI(realPath: string, wasiPath: string): Promise<void> {
        if (!this.initialized || !this.memFs) {
            await this.initialize();
        }
        
        try {
            const content = await fs.promises.readFile(realPath);
            
            // Ensure parent directory exists in MemFS
            const dir = path.dirname(wasiPath);
            if (dir !== '/' && dir !== '.') {
                try {
                    this.memFs!.createDir(dir);
                } catch {
                    // Directory might already exist, ignore error
                }
            }
            
            // Open/create file in MemFS and write content
            // MemFS.open() returns a JSVirtualFile that has write() method
            const file = this.memFs!.open(wasiPath, { read: true, write: true, create: true });
            file.write(new Uint8Array(content));
            file.flush();
            
            logger.info(`[WASMRuntime] Prepared file for WASI: ${realPath} -> ${wasiPath} (${content.length} bytes)`);
        } catch (error: any) {
            logger.error(`[WASMRuntime] Failed to prepare file for WASI: ${realPath}`, error);
            throw new Error(`Failed to prepare file for WASI: ${error.message}`);
        }
    }

    /**
     * Clear all files from MemFS (useful between executions)
     */
    clearMemFS(): void {
        if (this.memFs) {
            // Reinitialize MemFS to clear all files
            this.memFs = new MemFS();
            logger.info('[WASMRuntime] MemFS cleared');
        }
    }

    /**
     * Wait for execution slot (concurrency control)
     */
    private async acquireExecutionSlot(): Promise<void> {
        if (this.activeExecutions < this.maxConcurrent) {
            this.activeExecutions++;
            return;
        }

        // Queue this execution
        return new Promise((resolve, reject) => {
            this.executionQueue.push({ resolve, reject });
            logger.info(`[WASMRuntime] Execution queued. Queue length: ${this.executionQueue.length}`);
        });
    }

    /**
     * Release execution slot and process queue
     */
    private releaseExecutionSlot(): void {
        this.activeExecutions--;
        this.processQueue();
    }

    /**
     * Process queued executions
     */
    private processQueue(): void {
        while (this.activeExecutions < this.maxConcurrent && this.executionQueue.length > 0) {
            const next = this.executionQueue.shift();
            if (next) {
                this.activeExecutions++;
                next.resolve();
                logger.info(`[WASMRuntime] Dequeued execution. Active: ${this.activeExecutions}, Queue: ${this.executionQueue.length}`);
            }
        }
    }

    /**
     * Execute a WASM binary with timeout and concurrency control
     * @param wasmBinary - The WASM binary (ArrayBuffer or Uint8Array)
     * @param functionName - Name of the function to call
     * @param args - Arguments to pass to the function
     * @param options - Execution options (timeout, memory limit)
     * @returns Execution result
     */
    async execute(
        wasmBinary: ArrayBuffer | Uint8Array,
        functionName: string,
        args: any[] = [],
        options?: WASMExecutionOptions
    ): Promise<WASMExecutionResult> {
        const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
        const startTime = Date.now();

        // Wait for execution slot (concurrency control)
        try {
            await this.acquireExecutionSlot();
        } catch (error: any) {
            return {
                success: false,
                error: `Queue error: ${error.message}`,
            };
        }

        try {
            // Prepare input files for WASI if specified
            if (options?.inputFiles) {
                // Clear MemFS to ensure clean state
                this.clearMemFS();
                
                // Prepare each input file
                for (const [realPath, wasiPath] of Object.entries(options.inputFiles)) {
                    await this.prepareFileForWASI(realPath, wasiPath);
                }
            }
            
            // Execute with timeout
            const result = await this.executeWithTimeout(
                wasmBinary,
                functionName,
                args,
                timeoutMs
            );
            
            return {
                ...result,
                executionTimeMs: Date.now() - startTime,
            };
        } finally {
            this.releaseExecutionSlot();
        }
    }

    /**
     * Execute with timeout wrapper
     */
    private async executeWithTimeout(
        wasmBinary: ArrayBuffer | Uint8Array,
        functionName: string,
        args: any[],
        timeoutMs: number
    ): Promise<WASMExecutionResult> {
        return new Promise(async (resolve) => {
            let timeoutId: NodeJS.Timeout | null = null;
            let completed = false;

            // Set up timeout
            timeoutId = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    logger.warn(`[WASMRuntime] Execution timed out after ${timeoutMs}ms`);
                    resolve({
                        success: false,
                        error: `Execution timed out after ${timeoutMs}ms`,
                    });
                }
            }, timeoutMs);

            try {
                const result = await this.executeInternal(wasmBinary, functionName, args);
                if (!completed) {
                    completed = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    resolve(result);
                }
            } catch (error: any) {
                if (!completed) {
                    completed = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    resolve({
                        success: false,
                        error: error.message || 'Unknown error',
                    });
                }
            }
        });
    }

    /**
     * Internal execution logic (no throttling, no timeout)
     */
    private async executeInternal(
        wasmBinary: ArrayBuffer | Uint8Array,
        functionName: string,
        args: any[] = []
    ): Promise<WASMExecutionResult> {
        if (!this.initialized) {
            await this.initialize();
        }

        if (!this.memFs) {
            throw new Error('WASMRuntime not properly initialized');
        }

        try {
            // Ensure wasmBinary is ArrayBuffer (convert Uint8Array if needed)
            let binaryBuffer: ArrayBuffer;
            if (wasmBinary instanceof Uint8Array) {
                // Create a new ArrayBuffer from Uint8Array to ensure proper type
                binaryBuffer = wasmBinary.buffer.slice(
                    wasmBinary.byteOffset,
                    wasmBinary.byteOffset + wasmBinary.byteLength
                ) as ArrayBuffer;
            } else {
                binaryBuffer = wasmBinary as ArrayBuffer;
            }

            // Compile WASM module
            const wasmModule = await WebAssembly.compile(binaryBuffer);

            // Check if module requires WASI by examining its imports
            const moduleImports = WebAssembly.Module.imports(wasmModule);
            const requiresWASI = moduleImports.some(
                (imp: any) => imp.module === 'wasi_snapshot_preview1' || 
                             imp.module === 'wasi_snapshot_preview2' ||
                             imp.module === 'wasi:cli'
            );

            logger.info(`[WASMRuntime] Module imports: ${moduleImports.map((i: any) => `${i.module}::${i.name}`).join(', ') || 'none'}`);
            logger.info(`[WASMRuntime] Module requires WASI: ${requiresWASI}`);

            // Try to instantiate with WASI first, fall back to standard WebAssembly if WASI fails
            let instance: WebAssembly.Instance;
            if (requiresWASI) {
                // Module requires WASI - must use WASI instantiation
                try {
                    // Create WASI instance
                    const wasi = new WASI({
                        env: {},
                        args: [],
                        preopens: {
                            '/': '/',
                        },
                        fs: this.memFs!,
                    });

                    // Get imports from WASI
                    const imports = wasi.getImports(wasmModule) as any;
                    logger.info(`[WASMRuntime] WASI imports provided: ${Object.keys(imports).length} import modules`);
                    logger.info(`[WASMRuntime] WASI import modules: ${Object.keys(imports).join(', ')}`);
                    
                    // Log what WASI is providing for wasi_snapshot_preview1
                    if (imports['wasi_snapshot_preview1']) {
                        const wasiImports = imports['wasi_snapshot_preview1'];
                        logger.info(`[WASMRuntime] WASI preview1 imports: ${Object.keys(wasiImports).join(', ')}`);
                    }

                    // Instantiate WASM module with WASI imports using WebAssembly.instantiate
                    // getImports() returns the import object for WebAssembly.instantiate
                    // WebAssembly.instantiate returns { instance, module }
                    const instantiationResult = await WebAssembly.instantiate(wasmModule, imports as any);
                    instance = (instantiationResult as any).instance || instantiationResult as WebAssembly.Instance;
                    logger.info('[WASMRuntime] ✅ Instantiated with WASI (module requires WASI)');
                    
                    // For WASI modules, we might need to call _start if it exists, but our calculator
                    // exports functions directly, so we don't need to call _start
                } catch (wasiError: any) {
                    // WASI instantiation failed for a WASI module - this is an error
                    logger.error('[WASMRuntime] ❌ WASI instantiation failed for WASI module:', wasiError);
                    throw new Error(`Failed to instantiate WASI module: ${wasiError.message}`);
                }
            } else {
                // Module doesn't require WASI - try standard WebAssembly instantiation
                try {
                    instance = await WebAssembly.instantiate(wasmModule, {
                        env: {},
                    });
                    logger.info('[WASMRuntime] ✅ Instantiated with standard WebAssembly (module does not require WASI)');
                } catch (stdError: any) {
                    // If standard instantiation fails, try with WASI as fallback
                    logger.info('[WASMRuntime] Standard instantiation failed, trying WASI as fallback:', stdError.message);
                    try {
                        const wasi = new WASI({
                            env: {},
                            args: [],
                            preopens: {
                                '/': '/',
                            },
                            fs: this.memFs!,
                        });
                        const imports = wasi.getImports(wasmModule);
                        const instantiationResult = await WebAssembly.instantiate(wasmModule, imports as any);
                        instance = (instantiationResult as any).instance || instantiationResult as WebAssembly.Instance;
                        logger.info('[WASMRuntime] ✅ Instantiated with WASI (fallback)');
                    } catch (wasiError: any) {
                        throw new Error(`Failed to instantiate WASM module: ${stdError.message}`);
                    }
                }
            }

            // Get the function
            const func = (instance.exports as any)[functionName];

            if (!func) {
                const availableFunctions = Object.keys(instance.exports).filter(
                    key => typeof (instance.exports as any)[key] === 'function'
                );
                throw new Error(
                    `Function "${functionName}" not found in WASM module. ` +
                    `Available functions: ${availableFunctions.join(', ')}`
                );
            }

            // Handle string arguments - if args contain strings, write them to WASM memory
            const processedArgs: any[] = [];
            let memory: WebAssembly.Memory | null = null;
            
            // Try to get memory from instance
            if (instance.exports.memory) {
                memory = instance.exports.memory as WebAssembly.Memory;
            }

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                
                // If argument is a string and we have memory, write it to memory
                if (typeof arg === 'string' && memory) {
                    // Encode string to UTF-8 bytes
                    const encoder = new TextEncoder();
                    const bytes = encoder.encode(arg);
                    
                    // Allocate memory in WASM (we need an alloc function, or use a fixed offset)
                    // For now, try to find an alloc function or use a simple approach
                    // If the function expects (ptr, len), we'll write to a known safe location
                    // For simplicity, let's write to offset 1024 (safe area)
                    const offset = 1024;
                    const memView = new Uint8Array(memory.buffer);
                    
                    // Check if we have enough space
                    if (offset + bytes.length > memView.length) {
                        // Grow memory if needed
                        const pagesNeeded = Math.ceil((offset + bytes.length - memView.length) / 65536) + 1;
                        memory.grow(pagesNeeded);
                    }
                    
                    // Write bytes to memory
                    const newMemView = new Uint8Array(memory.buffer);
                    newMemView.set(bytes, offset);
                    
                    // Pass pointer and length
                    processedArgs.push(offset);
                    processedArgs.push(bytes.length);
                } else {
                    // Pass argument as-is
                    processedArgs.push(arg);
                }
            }

            // Execute the function with processed arguments
            const result = func(...processedArgs);

            logger.info(`[WASMRuntime] Executed function "${functionName}" with args:`, args, 'Result:', result);

            return {
                success: true,
                result: result,
            };
        } catch (error: any) {
            logger.error('[WASMRuntime] Execution failed:', error);
            return {
                success: false,
                error: error.message || 'Unknown error',
            };
        }
    }

    /**
     * Write raw bytes to MemFS (without reading from host filesystem).
     */
    private writeToMemFS(wasiPath: string, data: Uint8Array | Buffer): void {
        if (!this.memFs) {
            throw new Error('WASMRuntime not properly initialized');
        }

        const dir = path.dirname(wasiPath);
        if (dir !== '/' && dir !== '.') {
            try {
                this.memFs.createDir(dir);
            } catch {
                // Directory might already exist
            }
        }

        const file = this.memFs.open(wasiPath, { read: true, write: true, create: true });
        file.write(new Uint8Array(data));
        file.flush();
    }

    /**
     * Read raw bytes from MemFS.
     * Returns null if the file doesn't exist.
     */
    private readFromMemFS(wasiPath: string): Uint8Array | null {
        if (!this.memFs) return null;
        try {
            const file = this.memFs.open(wasiPath, { read: true, write: false, create: false });
            const content = file.read();
            return content ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Execute the dDRM universal renderer WASM binary.
     *
     * Orchestrates MemFS lifecycle:
     *   1. Write /input/command.json (render parameters + CEK)
     *   2. Write /input/encrypted.bin (raw encrypted content)
     *   3. Run WASI _start
     *   4. Read /output/result.json + /output/rendered.bin
     *
     * CEK and plaintext are confined to WASM linear memory.
     */
    async executeRenderer(
        wasmBinary: ArrayBuffer | Uint8Array,
        command: RendererCommand,
        encryptedBytes: Buffer,
        options?: { timeoutMs?: number }
    ): Promise<RendererOutput> {
        const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
        const startTime = Date.now();

        try {
            await this.acquireExecutionSlot();
        } catch (error: any) {
            return {
                result: { success: false, error: `Queue error: ${error.message}` },
                renderedBytes: null,
                executionTimeMs: Date.now() - startTime,
            };
        }

        try {
            if (!this.initialized) {
                await this.initialize();
            }

            // Fresh MemFS for isolation
            this.clearMemFS();

            // Write inputs to MemFS
            const commandJson = JSON.stringify(command);
            this.writeToMemFS('/input/command.json', Buffer.from(commandJson, 'utf-8'));
            this.writeToMemFS('/input/encrypted.bin', encryptedBytes);

            logger.info(`[WASMRuntime] Renderer input: command=${commandJson.length}B, encrypted=${encryptedBytes.length}B`);

            // Run WASI _start with timeout
            const wasiResult = await this.executeWASIStart(wasmBinary, timeoutMs);
            if (!wasiResult.success) {
                return {
                    result: { success: false, error: wasiResult.error ?? 'WASI execution failed' },
                    renderedBytes: null,
                    executionTimeMs: Date.now() - startTime,
                };
            }

            // Read result from three sources (in priority order):
            // 1. WASI's own MemFS (wasi.fs) — most reliable after wasi.instantiate()
            // 2. Our shared MemFS (this.memFs) — in case they share backing store
            // 3. stdout — fallback written by the Rust binary
            const outputFs = wasiResult.wasiFs;
            let resultJson: string | null = null;

            if (outputFs) {
                const bytes = this.readFromSpecificMemFS(outputFs, '/output/result.json');
                if (bytes) resultJson = new TextDecoder().decode(bytes);
            }
            if (!resultJson) {
                const bytes = this.readFromMemFS('/output/result.json');
                if (bytes) resultJson = new TextDecoder().decode(bytes);
            }
            if (!resultJson && wasiResult.stdout) {
                resultJson = wasiResult.stdout;
                logger.info(`[WASMRuntime] Using stdout fallback for result (${resultJson.length}B)`);
            }

            if (!resultJson) {
                return {
                    result: { success: false, error: 'Renderer produced no output (MemFS + stdout empty)' },
                    renderedBytes: null,
                    executionTimeMs: Date.now() - startTime,
                };
            }

            let result: RendererResult;
            try {
                result = JSON.parse(resultJson);
            } catch (e) {
                return {
                    result: { success: false, error: `Invalid result JSON: ${resultJson.slice(0, 200)}` },
                    renderedBytes: null,
                    executionTimeMs: Date.now() - startTime,
                };
            }

            let renderedBytes: Buffer | null = null;
            if (result.success) {
                // Try reading rendered bytes from both MemFS sources
                let rendered: Uint8Array | null = null;
                if (outputFs) {
                    rendered = this.readFromSpecificMemFS(outputFs, '/output/rendered.bin');
                }
                if (!rendered) {
                    rendered = this.readFromMemFS('/output/rendered.bin');
                }
                if (rendered) {
                    renderedBytes = Buffer.from(rendered);
                }
            }

            logger.info(`[WASMRuntime] Renderer output: success=${result.success}, type=${result.content_type}, size=${renderedBytes?.length ?? 0}B`);

            return {
                result,
                renderedBytes,
                executionTimeMs: Date.now() - startTime,
            };
        } catch (error: any) {
            logger.error('[WASMRuntime] Renderer execution failed:', error);
            return {
                result: { success: false, error: error.message || 'Unknown error' },
                renderedBytes: null,
                executionTimeMs: Date.now() - startTime,
            };
        } finally {
            this.clearMemFS();
            this.releaseExecutionSlot();
        }
    }

    /**
     * Read a file from a specific MemFS instance (used to read from WASI's MemFS).
     */
    private readFromSpecificMemFS(memFs: MemFS, wasiPath: string): Uint8Array | null {
        try {
            const file = memFs.open(wasiPath, { read: true, write: false, create: false });
            const content = file.read();
            return content ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Run a WASI module's _start entry point with timeout.
     *
     * Uses wasi.instantiate() + wasi.start() which properly handles
     * proc_exit(0) — the normal WASI exit that Rust main() triggers.
     * Returns the WASI's own MemFS so the caller can read output files
     * (wasi.instantiate may use an internal MemFS view).
     */
    private async executeWASIStart(
        wasmBinary: ArrayBuffer | Uint8Array,
        timeoutMs: number
    ): Promise<{ success: boolean; error?: string; wasiFs?: MemFS; stdout?: string }> {
        return new Promise(async (resolve) => {
            let timeoutId: NodeJS.Timeout | null = null;
            let completed = false;

            timeoutId = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    logger.warn(`[WASMRuntime] Renderer timed out after ${timeoutMs}ms`);
                    resolve({ success: false, error: `Renderer timed out after ${timeoutMs}ms` });
                }
            }, timeoutMs);

            try {
                let binaryBuffer: ArrayBuffer;
                if (wasmBinary instanceof Uint8Array) {
                    binaryBuffer = wasmBinary.buffer.slice(
                        wasmBinary.byteOffset,
                        wasmBinary.byteOffset + wasmBinary.byteLength
                    ) as ArrayBuffer;
                } else {
                    binaryBuffer = wasmBinary;
                }

                const wasmModule = await WebAssembly.compile(binaryBuffer);

                const wasi = new WASI({
                    env: {},
                    args: ['ddrm-renderer'],
                    preopens: { '/': '/' },
                    fs: this.memFs!,
                });

                wasi.instantiate(wasmModule);

                let exitCode: number;
                try {
                    exitCode = wasi.start();
                } catch (startErr: any) {
                    // Safety net: check if output was written before the trap
                    const outputExists = this.readFromSpecificMemFS(wasi.fs, '/output/result.json');
                    const stdout = wasi.getStdoutString();
                    if (outputExists || stdout) {
                        logger.info(`[WASMRuntime] WASI start() threw but output exists — treating as clean exit: ${startErr.message}`);
                        if (!completed) {
                            completed = true;
                            if (timeoutId) clearTimeout(timeoutId);
                            resolve({ success: true, wasiFs: wasi.fs, stdout });
                        }
                        return;
                    }
                    throw startErr;
                }

                const stdout = wasi.getStdoutString();
                logger.info(`[WASMRuntime] WASI module exited with code ${exitCode}`);

                if (!completed) {
                    completed = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    if (exitCode === 0) {
                        resolve({ success: true, wasiFs: wasi.fs, stdout });
                    } else {
                        resolve({ success: false, error: `WASI module exited with code ${exitCode}` });
                    }
                }
            } catch (error: any) {
                if (!completed) {
                    completed = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    resolve({ success: false, error: error.message || 'WASI execution error' });
                }
            }
        });
    }

    /**
     * Load WASM binary from file path (local to PC2 node)
     * @param filePath - Path to WASM file (relative to project root or absolute)
     * @returns WASM binary as ArrayBuffer
     */
    async loadFromFile(filePath: string): Promise<ArrayBuffer> {
        try {
            // Resolve path relative to project root (ES module compatible)
            // From dist/services/wasm/WASMRuntime.js, go up 3 levels to reach project root
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const projectRoot = path.resolve(__dirname, '../../..');
            const resolvedPath = path.isAbsolute(filePath) 
                ? filePath 
                : path.join(projectRoot, filePath);

            // Check if file exists
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`WASM file not found: ${resolvedPath}`);
            }

            // Read file
            const buffer = fs.readFileSync(resolvedPath);
            logger.info(`[WASMRuntime] Loaded WASM binary from: ${resolvedPath} (${buffer.length} bytes)`);

            return buffer.buffer;
        } catch (error: any) {
            logger.error('[WASMRuntime] Failed to load WASM file:', error);
            throw new Error(`Failed to load WASM file: ${error.message}`);
        }
    }

    /**
     * List available WASM functions in a binary
     * @param wasmBinary - The WASM binary
     * @returns Array of function names
     */
    async listFunctions(wasmBinary: ArrayBuffer | Uint8Array): Promise<string[]> {
        if (!this.initialized) {
            await this.initialize();
        }

        if (!this.memFs) {
            throw new Error('WASMRuntime not properly initialized');
        }

        try {
            // Ensure wasmBinary is ArrayBuffer (convert Uint8Array if needed)
            let binaryBuffer: ArrayBuffer;
            if (wasmBinary instanceof Uint8Array) {
                // Create a new ArrayBuffer from Uint8Array to ensure proper type
                binaryBuffer = wasmBinary.buffer.slice(
                    wasmBinary.byteOffset,
                    wasmBinary.byteOffset + wasmBinary.byteLength
                ) as ArrayBuffer;
            } else {
                binaryBuffer = wasmBinary as ArrayBuffer;
            }

            const wasmModule = await WebAssembly.compile(binaryBuffer);
            
            // Try to instantiate with WASI first, fall back to standard WebAssembly if WASI fails
            let instance: WebAssembly.Instance;
            try {
                const wasi = new WASI({
                    env: {},
                    args: [],
                    preopens: {
                        '/': '/',
                    },
                    fs: this.memFs!,
                });
                const imports = wasi.getImports(wasmModule);
                instance = wasi.instantiate(wasmModule, imports);
            } catch (wasiError: any) {
                // If WASI fails, try standard WebAssembly instantiation
                instance = await WebAssembly.instantiate(wasmModule, {
                    env: {},
                });
            }

            const functions = Object.keys(instance.exports).filter(
                key => typeof (instance.exports as any)[key] === 'function'
            );

            return functions;
        } catch (error: any) {
            logger.error('[WASMRuntime] Failed to list functions:', error);
            return [];
        }
    }
}

// Singleton instance with configuration from global config
let wasmRuntimeInstance: WASMRuntime | null = null;

export function getWASMRuntime(): WASMRuntime {
    if (!wasmRuntimeInstance) {
        // Read config from global if available
        const config = (global as any).pc2Config?.resources?.compute;
        wasmRuntimeInstance = new WASMRuntime({
            maxConcurrent: config?.max_concurrent_wasm ?? 4,
            defaultTimeoutMs: config?.wasm_timeout_ms ?? 30000,
            defaultMaxMemoryMb: config?.max_memory_mb ?? 512,
        });
    }
    return wasmRuntimeInstance;
}

export default WASMRuntime;
