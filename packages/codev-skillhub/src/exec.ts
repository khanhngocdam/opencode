import { execFile } from "node:child_process"

export interface ExecResult {
  stdout: string
  stderr: string
  error: NodeJS.ErrnoException | null
}

// On Windows, agent CLIs are `.cmd` shims that execFile can't resolve without
// a shell. Composing the command string ourselves (rather than the deprecated
// (file, args, {shell: true}) signature, DEP0190) is safe here: callers pass
// fixed flags with no whitespace.
const USE_SHELL = process.platform === "win32"

// Object indirection so tests can stub child processes without module mocks.
export const execApi = {
  execAsync(file: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      const done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) =>
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error as NodeJS.ErrnoException | null,
        })
      if (USE_SHELL) {
        const command = `${file.includes(" ") ? `"${file}"` : file} ${args.join(" ")}`
        execFile(command, { shell: true }, done)
        return
      }
      execFile(file, args, done)
    })
  },
}
