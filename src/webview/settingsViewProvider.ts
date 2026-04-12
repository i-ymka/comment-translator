import * as vscode from 'vscode';
import { TranslationService } from '../translationService';
import { FileParser, ContentType } from '../fileParser';

export class SettingsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'commentTranslator.settingsView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly translationService: TranslationService,
        private readonly fileParser: FileParser
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'translate':
                    await this.executeTranslation();
                    break;
                case 'checkUsage':
                    await this.checkUsage();
                    break;
                case 'saveSettings':
                    await this.saveSettings(data.settings);
                    break;
            }
        });

        // Load initial settings
        this.loadSettings();
    }

    private async loadSettings() {
        if (!this._view) {
            return;
        }

        const config = vscode.workspace.getConfiguration('commentTranslator');
        const settings = {
            apiKey: config.get<string>('deeplApiKey', ''),
            targetLanguage: config.get<string>('targetLanguage', 'EN-US'),
            translateComments: config.get<boolean>('translateComments', true),
            translateLogs: config.get<boolean>('translateLogs', true),
            translatePrints: config.get<boolean>('translatePrints', true),
            translateErrors: config.get<boolean>('translateErrors', true),
            translateStrings: config.get<boolean>('translateStrings', false),
            mode: config.get<string>('mode', 'preview'),
            scope: config.get<string>('scope', 'currentFile'),
        };

        this._view.webview.postMessage({ type: 'loadSettings', settings });
    }

    private async saveSettings(settings: any) {
        const config = vscode.workspace.getConfiguration('commentTranslator');
        await config.update('deeplApiKey', settings.apiKey, vscode.ConfigurationTarget.Global);
        await config.update('targetLanguage', settings.targetLanguage, vscode.ConfigurationTarget.Global);
        await config.update('translateComments', settings.translateComments, vscode.ConfigurationTarget.Global);
        await config.update('translateLogs', settings.translateLogs, vscode.ConfigurationTarget.Global);
        await config.update('translatePrints', settings.translatePrints, vscode.ConfigurationTarget.Global);
        await config.update('translateErrors', settings.translateErrors, vscode.ConfigurationTarget.Global);
        await config.update('translateStrings', settings.translateStrings, vscode.ConfigurationTarget.Global);
        await config.update('mode', settings.mode, vscode.ConfigurationTarget.Global);
        await config.update('scope', settings.scope, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage('Settings saved successfully');
    }

    public async executeTranslation() {
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const scope = config.get<string>('scope', 'currentFile') as 'currentFile' | 'wholeProject';
        const mode = config.get<string>('mode', 'preview');

        // Get files to process
        const files = await this.fileParser.getFilesToProcess(scope);
        if (files.length === 0) {
            vscode.window.showWarningMessage('No files to translate. Please open a file or select a project.');
            return;
        }

        // Show progress
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Translating...',
                cancellable: true,
            },
            async (progress, token) => {
                let processedFiles = 0;

                for (const fileUri of files) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    progress.report({
                        message: `Processing ${fileUri.fsPath.split('/').pop()} (${processedFiles + 1}/${files.length})`,
                        increment: (100 / files.length),
                    });

                    await this.translateFile(fileUri, mode);
                    processedFiles++;
                }

                vscode.window.showInformationMessage(
                    `Translation complete! Processed ${processedFiles} file(s).`
                );
            }
        );
    }

    private async translateFile(fileUri: vscode.Uri, mode: string) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const config = vscode.workspace.getConfiguration('commentTranslator');

        // Extract content based on settings
        const extractedContent = await this.fileParser.extractContent(document, {
            comments: config.get<boolean>('translateComments', true),
            logs: config.get<boolean>('translateLogs', true),
            prints: config.get<boolean>('translatePrints', true),
            errors: config.get<boolean>('translateErrors', true),
            strings: config.get<boolean>('translateStrings', false),
        });

        if (extractedContent.length === 0) {
            return;
        }

        // Translate all content
        const textsToTranslate = extractedContent.map((item) => item.text);
        const translations = await this.translationService.translateBatch(textsToTranslate);

        if (translations.length === 0) {
            return;
        }

        // Apply translations
        const edit = new vscode.WorkspaceEdit();
        let translatedText = document.getText();

        // Process in reverse order to maintain positions
        for (let i = extractedContent.length - 1; i >= 0; i--) {
            const content = extractedContent[i];
            const translation = translations[i];

            if (translation && translation.translated !== content.text) {
                const position = document.positionAt(
                    this.getOffset(translatedText, content.line, content.startChar)
                );

                // Replace the text content while preserving the syntax
                const newFullMatch = content.fullMatch.replace(
                    content.text,
                    translation.translated
                );

                const range = new vscode.Range(
                    position,
                    document.positionAt(
                        this.getOffset(translatedText, content.line, content.endChar)
                    )
                );

                edit.replace(fileUri, range, newFullMatch);
            }
        }

        if (mode === 'preview') {
            // Show diff view
            await vscode.workspace.applyEdit(edit);
            const modifiedDocument = await vscode.workspace.openTextDocument(fileUri);
            await vscode.commands.executeCommand(
                'vscode.diff',
                document.uri,
                modifiedDocument.uri,
                `Translation Preview: ${fileUri.fsPath.split('/').pop()}`
            );
        } else {
            // Direct replacement
            await vscode.workspace.applyEdit(edit);
            await document.save();
        }
    }

    private getOffset(text: string, line: number, char: number): number {
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < line; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        return offset + char;
    }

    private async checkUsage() {
        const usage = await this.translationService.checkUsage();
        if (usage) {
            const limit = usage.character?.limit || 0;
            const count = usage.character?.count || 0;
            const remaining = limit - count;
            const percentage = limit > 0 ? ((count / limit) * 100).toFixed(2) : '0';

            vscode.window.showInformationMessage(
                `DeepL Usage: ${count.toLocaleString()} / ${limit.toLocaleString()} characters (${percentage}%)\n` +
                `Remaining: ${remaining.toLocaleString()} characters`
            );

            if (this._view) {
                this._view.webview.postMessage({
                    type: 'usage',
                    usage: { count, limit, remaining, percentage },
                });
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Comment Translator Settings</title>
    <style>
        body {
            padding: 10px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        .section {
            margin-bottom: 20px;
        }

        .section-title {
            font-weight: bold;
            margin-bottom: 10px;
            color: var(--vscode-textLink-foreground);
        }

        label {
            display: block;
            margin-bottom: 5px;
        }

        input[type="text"], select {
            width: 100%;
            padding: 5px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            margin-bottom: 10px;
        }

        input[type="checkbox"] {
            margin-right: 5px;
        }

        .checkbox-group {
            margin-left: 10px;
        }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 14px;
            cursor: pointer;
            margin-right: 5px;
            margin-top: 10px;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .usage-info {
            padding: 10px;
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            margin-top: 10px;
            font-size: 12px;
        }

        .warning {
            color: var(--vscode-editorWarning-foreground);
            font-size: 11px;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="section">
        <div class="section-title">API Configuration</div>
        <label for="apiKey">DeepL API Key:</label>
        <input type="text" id="apiKey" placeholder="Enter your DeepL API key">
        <div class="warning">Get your free API key at: https://www.deepl.com/pro-api</div>
    </div>

    <div class="section">
        <div class="section-title">Target Language</div>
        <select id="targetLanguage">
            <option value="EN-US">English (US)</option>
            <option value="EN-GB">English (UK)</option>
            <option value="DE">German</option>
            <option value="FR">French</option>
            <option value="ES">Spanish</option>
            <option value="IT">Italian</option>
            <option value="PT-PT">Portuguese (Portugal)</option>
            <option value="PT-BR">Portuguese (Brazil)</option>
            <option value="RU">Russian</option>
            <option value="JA">Japanese</option>
            <option value="ZH">Chinese</option>
        </select>
    </div>

    <div class="section">
        <div class="section-title">What to Translate</div>
        <div class="checkbox-group">
            <label><input type="checkbox" id="translateComments" checked> Comments</label>
            <label><input type="checkbox" id="translateLogs" checked> Log statements</label>
            <label><input type="checkbox" id="translatePrints" checked> Print statements</label>
            <label><input type="checkbox" id="translateErrors" checked> Error messages</label>
            <label><input type="checkbox" id="translateStrings"> All string literals</label>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Mode</div>
        <select id="mode">
            <option value="preview">Show Preview (Diff View)</option>
            <option value="replace">Replace Directly</option>
        </select>
    </div>

    <div class="section">
        <div class="section-title">Scope</div>
        <select id="scope">
            <option value="currentFile">Current File</option>
            <option value="wholeProject">Whole Project</option>
        </select>
    </div>

    <button id="translateBtn">Translate</button>
    <button id="checkUsageBtn">Check Usage</button>
    <button id="saveBtn">Save Settings</button>

    <div id="usageInfo" class="usage-info" style="display:none;"></div>

    <script>
        const vscode = acquireVsCodeApi();

        // Load settings
        window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'loadSettings') {
                const settings = message.settings;
                document.getElementById('apiKey').value = settings.apiKey || '';
                document.getElementById('targetLanguage').value = settings.targetLanguage || 'EN-US';
                document.getElementById('translateComments').checked = settings.translateComments !== false;
                document.getElementById('translateLogs').checked = settings.translateLogs !== false;
                document.getElementById('translatePrints').checked = settings.translatePrints !== false;
                document.getElementById('translateErrors').checked = settings.translateErrors !== false;
                document.getElementById('translateStrings').checked = settings.translateStrings === true;
                document.getElementById('mode').value = settings.mode || 'preview';
                document.getElementById('scope').value = settings.scope || 'currentFile';
            }

            if (message.type === 'usage') {
                const usage = message.usage;
                const usageDiv = document.getElementById('usageInfo');
                usageDiv.style.display = 'block';
                usageDiv.innerHTML =
                    \`<strong>API Usage:</strong><br>\` +
                    \`Used: \${usage.count.toLocaleString()} / \${usage.limit.toLocaleString()} characters (\${usage.percentage}%)<br>\` +
                    \`Remaining: \${usage.remaining.toLocaleString()} characters\`;
            }
        });

        // Translate button
        document.getElementById('translateBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'translate' });
        });

        // Check usage button
        document.getElementById('checkUsageBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'checkUsage' });
        });

        // Save settings button
        document.getElementById('saveBtn').addEventListener('click', () => {
            const settings = {
                apiKey: document.getElementById('apiKey').value,
                targetLanguage: document.getElementById('targetLanguage').value,
                translateComments: document.getElementById('translateComments').checked,
                translateLogs: document.getElementById('translateLogs').checked,
                translatePrints: document.getElementById('translatePrints').checked,
                translateErrors: document.getElementById('translateErrors').checked,
                translateStrings: document.getElementById('translateStrings').checked,
                mode: document.getElementById('mode').value,
                scope: document.getElementById('scope').value,
            };
            vscode.postMessage({ type: 'saveSettings', settings });
        });
    </script>
</body>
</html>`;
    }
}
