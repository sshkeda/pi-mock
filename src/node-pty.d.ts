/**
 * Minimal type declaration for node-pty (optional dependency).
 *
 * node-pty is only required for interactive mode testing.
 * Users who don't need interactive mode don't need to install it.
 */
declare module "node-pty" {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(callback: (data: string) => void): IDisposable;
    onExit(callback: (e: { exitCode: number; signal?: number }) => void): IDisposable;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export function spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
}
