import * as vscode from 'vscode';
import * as fs from 'fs';

import { JestRunnerConfig } from './jestRunnerConfig';
import { parse } from './parser';
import {
  escapeRegExp,
  escapeRegExpForPath,
  escapeSingleQuotes,
  findFullTestName,
  getFileName,
  getDirName,
  normalizePath,
  pushMany,
  quote,
  unquote,
  updateTestNameIfUsingProperties,
} from './util';

interface DebugCommand {
  documentUri: vscode.Uri;
  config: vscode.DebugConfiguration;
}

export class JestRunner {
  private previousCommand: string | DebugCommand;

  private terminal: vscode.Terminal;

  // support for running in a native external terminal
  // force runTerminalCommand to push to a queue and run in a native external
  // terminal after all commands been pushed
  private openNativeTerminal: boolean;
  private commands: string[] = [];

  constructor(private readonly config: JestRunnerConfig) {
    this.setup();
    this.openNativeTerminal = config.isRunInExternalNativeTerminal;
  }

  //
  // public methods
  //

  public async runTestsOnPath(path: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const workspacePath = this.getWorkspacePath(editor);
    const command = this.buildJestCommand(workspacePath, path);

    this.previousCommand = command;

    await this.goToCwd();
    await this.runTerminalCommand(command);

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  public async runCurrentTest(
    argument?: Record<string, unknown> | string,
    options?: string[],
    collectCoverageFromCurrentFile?: boolean,
  ): Promise<void> {
    const currentTestName = typeof argument === 'string' ? argument : undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    await editor.document.save();

    const filePath = editor.document.fileName;

    const finalOptions = options;
    if (collectCoverageFromCurrentFile) {
      const targetFileDir = getDirName(filePath);
      const targetFileName = getFileName(filePath).replace(/\.(test|spec)\./, '.');

      // if a file does not exist with the same name as the test file but without the test/spec part
      // use test file's directory for coverage target
      const coverageTarget = fs.existsSync(`${targetFileDir}/${targetFileName}`)
        ? `**/${targetFileName}`
        : `**/${getFileName(targetFileDir)}/**`;

      finalOptions.push('--collectCoverageFrom');
      finalOptions.push(quote(coverageTarget));
    }

    const testName = currentTestName || this.findCurrentTestName(editor);
    const resolvedTestName = updateTestNameIfUsingProperties(testName);
    const command = this.buildJestCommand(this.getWorkspacePath(editor), filePath, resolvedTestName, finalOptions);

    this.previousCommand = command;

    await this.goToCwd();
    await this.runTerminalCommand(command);

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  public async runCurrentFile(options?: string[]): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    await editor.document.save();

    const filePath = editor.document.fileName;
    const command = this.buildJestCommand(this.getWorkspacePath(editor), filePath, undefined, options);

    this.previousCommand = command;

    await this.goToCwd();
    await this.runTerminalCommand(command);

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  public async runPreviousTest(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    await editor.document.save();

    if (typeof this.previousCommand === 'string') {
      await this.goToCwd();
      await this.runTerminalCommand(this.previousCommand);
    } else {
      await this.executeDebugCommand(this.previousCommand);
    }

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  public async debugTestsOnPath(path: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const workspacePath = this.getWorkspacePath(editor);
    const debugConfig = this.getDebugConfig(workspacePath, path);

    await this.goToCwd();
    await this.executeDebugCommand({
      config: debugConfig,
      documentUri: vscode.Uri.file(path),
    });

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  public async debugCurrentTest(currentTestName?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    await editor.document.save();

    const filePath = editor.document.fileName;
    const testName = currentTestName || this.findCurrentTestName(editor);
    const resolvedTestName = updateTestNameIfUsingProperties(testName);
    const debugConfig = this.getDebugConfig(this.getWorkspacePath(editor), filePath, resolvedTestName);

    await this.goToCwd();
    await this.executeDebugCommand({
      config: debugConfig,
      documentUri: editor.document.uri,
    });

    await this.runExternalNativeTerminalCommand(this.commands);
  }

  //
  // private methods
  //

  private getWorkspacePath(editor: vscode.TextEditor): string {
    const workspacePath = vscode.workspace.getWorkspaceFolder(editor.document.uri).uri.fsPath;
    return workspacePath;
  }

  private async executeDebugCommand(debugCommand: DebugCommand) {
    // prevent open of external terminal when debug command is executed
    this.openNativeTerminal = false;

    for (const command of this.commands) {
      await this.runTerminalCommand(command);
    }
    this.commands = [];

    vscode.debug.startDebugging(undefined, debugCommand.config);

    this.previousCommand = debugCommand;
  }

  private getDebugConfig(workspacePath: string, filePath: string, currentTestName?: string): vscode.DebugConfiguration {
    const config: vscode.DebugConfiguration = {
      console: 'integratedTerminal',
      internalConsoleOptions: 'neverOpen',
      name: 'Debug Jest Tests',
      program: this.config.jestBinPath,
      request: 'launch',
      type: 'node',
      cwd: this.config.cwd,
      ...this.config.debugOptions,
    };

    config.args = config.args ? config.args.slice() : [];

    if (this.config.isYarnPnpSupportEnabled) {
      config.args = ['jest'];
      config.program = `.yarn/releases/${this.config.getYarnPnpCommand}`;
    }

    const standardArgs = this.buildJestArgs(workspacePath, filePath, currentTestName, false);
    pushMany(config.args, standardArgs);
    config.args.push('--runInBand');

    return config;
  }

  private findCurrentTestName(editor: vscode.TextEditor): string | undefined {
    // from selection
    const { selection, document } = editor;
    if (!selection.isEmpty) {
      return unquote(document.getText(selection));
    }

    const selectedLine = selection.active.line + 1;
    const filePath = editor.document.fileName;
    const testFile = parse(filePath);

    const fullTestName = findFullTestName(selectedLine, testFile.root.children);
    return fullTestName ? escapeRegExp(fullTestName) : undefined;
  }

  private buildJestCommand(workspacePath: string, filePath: string, testName?: string, options?: string[]): string {
    const args = this.buildJestArgs(workspacePath, filePath, testName, true, options);
    return `${this.config.jestCommand} ${args.join(' ')}`;
  }

  private buildJestArgs(workspacePath: string, filePath: string, testName: string, withQuotes: boolean, options: string[] = []): string[] {
    const args: string[] = [];
    const quoter = withQuotes ? quote : (str) => str;

    args.push(quoter(escapeRegExpForPath(normalizePath(filePath))));

    const jestConfigPath = this.config.getJestConfigPath(filePath);
    if (jestConfigPath) {
      args.push('-c');
      args.push(quoter(normalizePath(jestConfigPath)));
    }

    if (testName) {
      args.push('-t');
      args.push(quoter(escapeSingleQuotes(testName)));
    }

    // roots -> workspacePath
    if (workspacePath) {
      args.push('--roots');
      args.push(quoter(escapeSingleQuotes(workspacePath)));
    }

    const setOptions = new Set(options);

    if (this.config.runOptions) {
      this.config.runOptions.forEach((option) => setOptions.add(option));
    }

    args.push(...setOptions);

    return args;
  }

  private async goToCwd() {
    const command = `cd ${quote(this.config.cwd)}`;
    if (this.config.changeDirectoryToWorkspaceRoot) {
      await this.runTerminalCommand(command);
    }
  }

  private buildNativeTerminalCommand(toRun: string): string {
    const command = `ttab -t 'jest-runner' "${toRun}"`;
    return command;
  }

  private async runExternalNativeTerminalCommand(commands: string[]): Promise<void> {
    if (!this.openNativeTerminal) {
      this.commands = [];
      return;
    }

    const command: string = commands.join('; ');
    const externalCommand: string = this.buildNativeTerminalCommand(command);
    this.commands = [];

    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal('jest');
    }

    this.terminal.show(this.config.preserveEditorFocus);
    await vscode.commands.executeCommand('workbench.action.terminal.clear');
    this.terminal.sendText(externalCommand);
  }

  private async runTerminalCommand(command: string) {
    if (this.openNativeTerminal) {
      this.commands.push(command);
      return;
    }

    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal('jest');
    }
    this.terminal.show(this.config.preserveEditorFocus);
    await vscode.commands.executeCommand('workbench.action.terminal.clear');
    this.terminal.sendText(command);
  }

  private setup() {
    vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
      if (this.terminal === closedTerminal) {
        this.terminal = null;
      }
    });
  }
}
