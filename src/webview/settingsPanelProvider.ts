import * as vscode from 'vscode';
import { TranslationService } from '../translationService';
import { FileParser } from '../fileParser';

interface TranslationPreviewProvider {
    update(uri: vscode.Uri, content: string): void;
    clear(uri: vscode.Uri): void;
}

export class SettingsPanelProvider {
    private panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private onDisposeCallback?: () => void;
    private selectedFiles: vscode.Uri[] = [];
    private pendingEdits: Map<string, { edit: vscode.WorkspaceEdit; originalContent: string; previewUri?: vscode.Uri }> = new Map();
    private currentTranslationFileUri: vscode.Uri | undefined;
    private onShowPreviewCallback?: () => void;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly translationService: TranslationService,
        private readonly fileParser: FileParser,
        private readonly previewProvider: TranslationPreviewProvider,
        onShowPreview?: () => void
    ) {
        this.onShowPreviewCallback = onShowPreview;
        // Create webview panel
        this.panel = vscode.window.createWebviewPanel(
            'commentTranslatorSettings',
            'Comment Translator Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this.extensionUri],
            }
        );

        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async (data) => {
                switch (data.type) {
                    case 'translateProject':
                        await this.executeTranslation('wholeProject');
                        break;
                    case 'selectFiles':
                        await this.selectFilesOnly();
                        break;
                    case 'translateSelected':
                        await this.translateSelectedFiles();
                        break;
                    case 'checkUsage':
                        await this.checkUsage();
                        break;
                    case 'saveSettings':
                        await this.saveSettings(data.settings);
                        break;
                }
            },
            null,
            this.disposables
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => {
                this.dispose();
            },
            null,
            this.disposables
        );

        // Load initial settings
        this.loadSettings();
    }

    public reveal() {
        this.panel.reveal(vscode.ViewColumn.One);
    }

    public onDispose(callback: () => void) {
        this.onDisposeCallback = callback;
    }

    private dispose() {
        if (this.onDisposeCallback) {
            this.onDisposeCallback();
        }

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }

        this.panel.dispose();
    }

    private async loadSettings() {
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const settings = {
            apiKey: config.get<string>('deeplApiKey', ''),
            targetLanguage: config.get<string>('targetLanguage', 'EN-US'),
            translateComments: config.get<boolean>('translateComments', true),
            translateLogs: config.get<boolean>('translateLogs', true),
            translatePrints: config.get<boolean>('translatePrints', true),
            translateErrors: config.get<boolean>('translateErrors', true),
            translateStrings: config.get<boolean>('translateStrings', false),
            translatePlainText: config.get<boolean>('translatePlainText', true),
            mode: config.get<string>('mode', 'preview'),
        };

        this.panel.webview.postMessage({ type: 'loadSettings', settings });
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
        await config.update('translatePlainText', settings.translatePlainText, vscode.ConfigurationTarget.Global);
        await config.update('mode', settings.mode, vscode.ConfigurationTarget.Global);

        // Reinitialize translator with new API key
        this.translationService.reinitialize();

        // Notify webview that settings were saved
        this.panel.webview.postMessage({ type: 'settingsSaved' });

        vscode.window.showInformationMessage('Settings saved successfully');
    }

    public async executeTranslation(scope: 'currentFile' | 'wholeProject' = 'wholeProject') {
        // Check API key first
        if (!this.translationService.isConfigured()) {
            vscode.window.showErrorMessage(
                'DeepL API key is not configured. Please set it in the settings panel and click "Save Settings".'
            );
            return;
        }

        const config = vscode.workspace.getConfiguration('commentTranslator');
        const mode = config.get<string>('mode', 'preview');

        // Get files to process (hide IDE and sensitive files by default)
        const files = await this.fileParser.getFilesToProcess(scope, false);

        console.log(`[Comment Translator] Found ${files.length} files to process`);

        if (files.length === 0) {
            const message = scope === 'currentFile'
                ? 'No file is currently open. Please open a file to translate.'
                : 'No files found to translate. Make sure you have a workspace opened.';
            vscode.window.showWarningMessage(message);
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
                let totalTranslations = 0;

                for (const fileUri of files) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const fileName = fileUri.fsPath.split('/').pop();
                    progress.report({
                        message: `Processing ${fileName} (${processedFiles + 1}/${files.length})`,
                        increment: (100 / files.length),
                    });

                    const count = await this.translateFile(fileUri, mode);
                    if (count === -1) {
                        // Error occurred, stop processing
                        return;
                    }
                    totalTranslations += count;
                    processedFiles++;

                    console.log(`[Comment Translator] Processed ${fileName}: ${count} translations`);
                }

                if (totalTranslations > 0) {
                    vscode.window.showInformationMessage(
                        `Translation complete! Processed ${processedFiles} file(s) with ${totalTranslations} translation(s).`
                    );
                } else if (processedFiles > 0) {
                    vscode.window.showInformationMessage(
                        `No translations needed. No non-English text found in ${processedFiles} file(s).`
                    );
                }
            }
        );
    }

    private async translateFile(fileUri: vscode.Uri, mode: string): Promise<number> {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const config = vscode.workspace.getConfiguration('commentTranslator');

        console.log(`[Comment Translator] Translating file: ${fileUri.fsPath}`);
        console.log(`[Comment Translator] File language ID: ${document.languageId}`);
        console.log(`[Comment Translator] File content length: ${document.getText().length} chars`);

        // Log extraction options
        const extractOptions = {
            comments: config.get<boolean>('translateComments', true),
            logs: config.get<boolean>('translateLogs', true),
            prints: config.get<boolean>('translatePrints', true),
            errors: config.get<boolean>('translateErrors', true),
            strings: config.get<boolean>('translateStrings', false),
            plainText: config.get<boolean>('translatePlainText', true),
        };
        console.log(`[Comment Translator] Extraction options:`, JSON.stringify(extractOptions));

        // Extract content based on settings
        const extractedContent = await this.fileParser.extractContent(document, extractOptions);

        console.log(`[Comment Translator] Found ${extractedContent.length} items to translate`);
        if (extractedContent.length > 0) {
            console.log(`[Comment Translator] First item:`, JSON.stringify(extractedContent[0]));
        }

        if (extractedContent.length === 0) {
            return 0;
        }

        // Translate all content
        const textsToTranslate = extractedContent.map((item) => item.text);
        const translations = await this.translationService.translateBatch(textsToTranslate);

        // Check if translation failed (returns empty array on error)
        if (translations.length === 0 && textsToTranslate.length > 0) {
            console.error('[Comment Translator] Translation failed - returned empty array');
            return -1; // Signal error
        }

        if (translations.length === 0) {
            return 0;
        }

        // Build translated content
        let translatedText = document.getText();
        const edit = new vscode.WorkspaceEdit();

        // Process in reverse order to maintain positions
        for (let i = extractedContent.length - 1; i >= 0; i--) {
            const content = extractedContent[i];
            const translation = translations[i];

            if (translation && translation.translated !== content.text) {
                const startOffset = this.getOffset(translatedText, content.line, content.startChar);
                const endOffset = this.getOffset(translatedText, content.line, content.endChar);

                // Replace the text content while preserving the syntax
                const newFullMatch = content.fullMatch.replace(
                    content.text,
                    translation.translated
                );

                translatedText = translatedText.substring(0, startOffset) +
                                newFullMatch +
                                translatedText.substring(endOffset);

                // Also build the edit for later
                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(endOffset);
                const range = new vscode.Range(startPos, endPos);
                edit.replace(fileUri, range, newFullMatch);
            }
        }

        if (mode === 'preview') {
            // Preview mode: show diff WITHOUT applying changes
            const fileName = fileUri.fsPath.split('/').pop();

            // Create virtual read-only document with translated content
            const previewUri = vscode.Uri.parse(`comment-translator-preview:${fileName}`);
            this.previewProvider.update(previewUri, translatedText);

            // Store pending edit for later
            this.pendingEdits.set(fileUri.toString(), {
                edit: edit,
                originalContent: document.getText(),
                previewUri: previewUri
            });

            // Store current file for toolbar button commands
            this.currentTranslationFileUri = fileUri;

            // Show diff: Original (left) vs Translated (right)
            await vscode.commands.executeCommand(
                'vscode.diff',
                fileUri,  // Original (left)
                previewUri,  // Translated (right)
                `Translation Preview: ${fileName}`,
                { preview: false, preserveFocus: false }
            );

            // Show status bar buttons for Apply/Cancel
            if (this.onShowPreviewCallback) {
                this.onShowPreviewCallback();
            }
        } else {
            // Replace mode: apply changes directly
            const originalContent = document.getText();
            await vscode.workspace.applyEdit(edit);
            await document.save();

            // Show undo option
            const action = await vscode.window.showInformationMessage(
                `Translated ${fileUri.fsPath.split('/').pop()}`,
                'Undo',
                'OK'
            );

            if (action === 'Undo') {
                await this.undoTranslation(fileUri, originalContent);
            }
        }

        return translations.length;
    }

    private async applyPendingEdit(fileUri: vscode.Uri): Promise<void> {
        const pending = this.pendingEdits.get(fileUri.toString());
        if (!pending) {
            return;
        }

        await vscode.workspace.applyEdit(pending.edit);
        const document = await vscode.workspace.openTextDocument(fileUri);
        await document.save();

        this.pendingEdits.delete(fileUri.toString());
        vscode.window.showInformationMessage('Translation applied successfully!');
    }

    private async undoTranslation(fileUri: vscode.Uri, originalContent: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(fileUri, fullRange, originalContent);
        await vscode.workspace.applyEdit(edit);
        await document.save();

        vscode.window.showInformationMessage('Translation reverted successfully!');
    }

    // Public method for toolbar "Apply" button
    public async applyCurrentTranslation(): Promise<void> {
        if (!this.currentTranslationFileUri) {
            vscode.window.showWarningMessage('No translation to apply.');
            return;
        }

        const pending = this.pendingEdits.get(this.currentTranslationFileUri.toString());
        if (!pending) {
            vscode.window.showWarningMessage('No pending translation found.');
            return;
        }

        // Apply the edit
        await vscode.workspace.applyEdit(pending.edit);
        const document = await vscode.workspace.openTextDocument(this.currentTranslationFileUri);
        await document.save();

        // Clean up
        if (pending.previewUri) {
            this.previewProvider.clear(pending.previewUri);
        }
        this.pendingEdits.delete(this.currentTranslationFileUri.toString());

        // Close the diff view
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        vscode.window.showInformationMessage('Translation applied successfully!');
        this.currentTranslationFileUri = undefined;
    }

    // Public method for toolbar "Revert" button
    public async revertCurrentTranslation(): Promise<void> {
        if (!this.currentTranslationFileUri) {
            vscode.window.showWarningMessage('No translation to revert.');
            return;
        }

        const pending = this.pendingEdits.get(this.currentTranslationFileUri.toString());

        // Clean up
        if (pending?.previewUri) {
            this.previewProvider.clear(pending.previewUri);
        }
        this.pendingEdits.delete(this.currentTranslationFileUri.toString());

        // Close the diff view
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        vscode.window.showInformationMessage('Translation cancelled.');
        this.currentTranslationFileUri = undefined;
    }

    private getOffset(text: string, line: number, char: number): number {
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < line; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        return offset + char;
    }

    public async selectFilesOnly() {
        // Create custom QuickPick with toggle button
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Select Files to Translate';
        quickPick.placeholder = 'Select files (Space to select, Enter to confirm)';
        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;

        let showAll = false;

        // Function to update button based on showAll state
        const updateButton = () => {
            const toggleButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon(showAll ? 'eye' : 'eye-closed'),
                tooltip: showAll
                    ? 'Hide IDE and sensitive files'
                    : 'Show all files (including IDE and sensitive files)',
            };
            quickPick.buttons = [toggleButton];
        };

        updateButton();

        // Function to load files
        const loadFiles = async (showAllFiles: boolean) => {
            quickPick.busy = true;
            const allFiles = await this.fileParser.getFilesToProcess('wholeProject', showAllFiles);
            console.log(`[Comment Translator] Found ${allFiles.length} files for selection (showAll: ${showAllFiles})`);

            quickPick.items = allFiles.map(file => {
                const relativePath = vscode.workspace.asRelativePath(file);
                return {
                    label: relativePath,
                    uri: file,
                };
            });
            quickPick.busy = false;
        };

        // Load files initially (without IDE/sensitive files)
        await loadFiles(false);

        // Handle toggle button click
        quickPick.onDidTriggerButton(async () => {
            showAll = !showAll;
            updateButton();
            await loadFiles(showAll);
        });

        // Show the quick pick
        quickPick.show();

        // Wait for user selection
        const selected = await new Promise<any[]>((resolve) => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems as any[]);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve([]);
                quickPick.dispose();
            });
        });

        if (!selected || selected.length === 0) {
            this.selectedFiles = [];
            vscode.window.showInformationMessage('No files selected.');
            return;
        }

        // Store selected files
        this.selectedFiles = selected.map((item: any) => item.uri);
        vscode.window.showInformationMessage(
            `Selected ${this.selectedFiles.length} file(s). Click "Translate Selected Files" to proceed.`
        );
    }

    public async translateSelectedFiles() {
        // Check if files are selected
        if (this.selectedFiles.length === 0) {
            vscode.window.showWarningMessage('No files selected. Please click "Select Files..." first.');
            return;
        }

        // Check API key
        if (!this.translationService.isConfigured()) {
            vscode.window.showErrorMessage(
                'DeepL API key is not configured. Please set it in the settings panel and click "Save Settings".'
            );
            return;
        }

        // Translate selected files
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const mode = config.get<string>('mode', 'preview');

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Translating selected files...',
                cancellable: true,
            },
            async (progress, token) => {
                let processedFiles = 0;
                let totalTranslations = 0;

                for (const fileUri of this.selectedFiles) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const fileName = fileUri.fsPath.split('/').pop();
                    progress.report({
                        message: `Processing ${fileName} (${processedFiles + 1}/${this.selectedFiles.length})`,
                        increment: (100 / this.selectedFiles.length),
                    });

                    const count = await this.translateFile(fileUri, mode);
                    if (count === -1) {
                        // Error occurred, stop processing
                        return;
                    }
                    totalTranslations += count;
                    processedFiles++;
                }

                if (totalTranslations > 0) {
                    vscode.window.showInformationMessage(
                        `Translation complete! Processed ${processedFiles} file(s) with ${totalTranslations} translation(s).`
                    );
                } else if (processedFiles > 0) {
                    vscode.window.showInformationMessage(
                        `No translations needed. No non-English text found in ${processedFiles} file(s).`
                    );
                }

                // Clear selection after translation
                this.selectedFiles = [];
            }
        );
    }

    private async checkUsage() {
        // Check if API key is configured
        if (!this.translationService.isConfigured()) {
            vscode.window.showErrorMessage(
                'DeepL API key is not configured. Please set it in the settings panel and click "Save Settings".'
            );
            return;
        }

        // Reinitialize translator to ensure it's ready
        this.translationService.reinitialize();

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

            this.panel.webview.postMessage({
                type: 'usage',
                usage: { count, limit, remaining, percentage },
            });
        } else {
            vscode.window.showErrorMessage(
                'Failed to get usage info. Please check your API key and try again.'
            );
        }
    }

    private getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Comment Translator</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Orbitron:wght@700;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --neon-cyan: #00f5ff;
            --neon-magenta: #ff00ff;
            --neon-green: #39ff14;
            --neon-amber: #ffb800;
            --dark-bg: #0a0a0f;
            --card-bg: rgba(15, 15, 25, 0.9);
            --border-color: rgba(0, 245, 255, 0.2);
            --text-primary: #e0e0e0;
            --text-dim: #888;
        }

        * {
            box-sizing: border-box;
        }

        body {
            padding: 0;
            margin: 0;
            background: var(--dark-bg);
            color: var(--text-primary);
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            min-height: 100vh;
            position: relative;
            overflow-x: hidden;
        }

        /* Scanline effect */
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: repeating-linear-gradient(
                0deg,
                transparent,
                transparent 2px,
                rgba(0, 0, 0, 0.1) 2px,
                rgba(0, 0, 0, 0.1) 4px
            );
            pointer-events: none;
            z-index: 1000;
        }

        /* Noise texture */
        body::after {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%' height='100%' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
            pointer-events: none;
            z-index: 999;
        }

        .container {
            max-width: 680px;
            margin: 0 auto;
            padding: 30px 20px;
            position: relative;
            z-index: 1;
        }

        /* Header */
        .header {
            text-align: center;
            margin-bottom: 40px;
            position: relative;
        }

        .logo {
            font-family: 'Orbitron', sans-serif;
            font-size: 28px;
            font-weight: 900;
            letter-spacing: 4px;
            text-transform: uppercase;
            background: linear-gradient(135deg, var(--neon-cyan), var(--neon-magenta));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            position: relative;
            display: inline-block;
            animation: glitch 3s infinite;
        }

        .logo::before,
        .logo::after {
            content: 'TRANSLATOR';
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, var(--neon-cyan), var(--neon-magenta));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .logo::before {
            animation: glitch-1 0.3s infinite;
            clip-path: polygon(0 0, 100% 0, 100% 35%, 0 35%);
        }

        .logo::after {
            animation: glitch-2 0.3s infinite;
            clip-path: polygon(0 65%, 100% 65%, 100% 100%, 0 100%);
        }

        @keyframes glitch {
            0%, 90%, 100% { opacity: 1; }
            92% { opacity: 0.8; }
        }

        @keyframes glitch-1 {
            0%, 100% { transform: translate(0); }
            20% { transform: translate(-2px, 1px); }
            40% { transform: translate(2px, -1px); }
            60% { transform: translate(-1px, 2px); }
        }

        @keyframes glitch-2 {
            0%, 100% { transform: translate(0); }
            20% { transform: translate(2px, -1px); }
            40% { transform: translate(-2px, 1px); }
            60% { transform: translate(1px, -2px); }
        }

        .subtitle {
            font-size: 11px;
            letter-spacing: 6px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-top: 8px;
        }

        .subtitle span {
            color: var(--neon-cyan);
        }

        /* Cards */
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            margin-bottom: 20px;
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(10px);
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--neon-cyan), transparent);
            animation: scan 2s linear infinite;
        }

        @keyframes scan {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }

        .card-header {
            background: rgba(0, 245, 255, 0.05);
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .card-icon {
            width: 8px;
            height: 8px;
            background: var(--neon-cyan);
            box-shadow: 0 0 10px var(--neon-cyan);
            animation: pulse 2s ease-in-out infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .card-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--neon-cyan);
        }

        .card-body {
            padding: 20px 16px;
        }

        /* Form elements */
        label {
            display: block;
            font-size: 11px;
            letter-spacing: 1px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-bottom: 8px;
        }

        input[type="text"], select {
            width: 100%;
            padding: 12px 14px;
            background: rgba(0, 0, 0, 0.4);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            transition: all 0.3s ease;
            outline: none;
        }

        input[type="text"]:focus, select:focus {
            border-color: var(--neon-cyan);
            box-shadow: 0 0 20px rgba(0, 245, 255, 0.2), inset 0 0 20px rgba(0, 245, 255, 0.05);
        }

        input[type="text"]::placeholder {
            color: var(--text-dim);
        }

        select {
            cursor: pointer;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2300f5ff' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 14px center;
        }

        select option {
            background: var(--dark-bg);
            color: var(--text-primary);
        }

        /* Checkboxes */
        .checkbox-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }

        .checkbox-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid transparent;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .checkbox-item:hover {
            border-color: var(--border-color);
            background: rgba(0, 245, 255, 0.05);
        }

        .checkbox-item input[type="checkbox"] {
            display: none;
        }

        .checkbox-box {
            width: 18px;
            height: 18px;
            border: 2px solid var(--border-color);
            position: relative;
            transition: all 0.2s ease;
        }

        .checkbox-item input:checked + .checkbox-box {
            border-color: var(--neon-cyan);
            background: rgba(0, 245, 255, 0.2);
        }

        .checkbox-item input:checked + .checkbox-box::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 5px;
            width: 4px;
            height: 8px;
            border: solid var(--neon-cyan);
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }

        .checkbox-label {
            font-size: 12px;
            color: var(--text-primary);
            text-transform: none;
            letter-spacing: 0;
        }

        /* Status messages */
        .status {
            font-size: 11px;
            margin-top: 10px;
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            animation: pulse 1.5s ease-in-out infinite;
        }

        .status.warning {
            background: rgba(255, 184, 0, 0.1);
            border-left: 2px solid var(--neon-amber);
        }

        .status.warning .status-dot {
            background: var(--neon-amber);
            box-shadow: 0 0 8px var(--neon-amber);
        }

        .status.success {
            background: rgba(57, 255, 20, 0.1);
            border-left: 2px solid var(--neon-green);
        }

        .status.success .status-dot {
            background: var(--neon-green);
            box-shadow: 0 0 8px var(--neon-green);
        }

        /* Buttons */
        .btn-row {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
        }

        .btn {
            flex: 1;
            padding: 12px 16px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 1px;
            text-transform: uppercase;
            border: 1px solid var(--border-color);
            background: rgba(0, 0, 0, 0.4);
            color: var(--text-primary);
            cursor: pointer;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }

        .btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(0, 245, 255, 0.2), transparent);
            transition: left 0.5s ease;
        }

        .btn:hover::before {
            left: 100%;
        }

        .btn:hover {
            border-color: var(--neon-cyan);
            box-shadow: 0 0 20px rgba(0, 245, 255, 0.2);
        }

        /* Action buttons */
        .actions-section {
            margin-top: 30px;
        }

        .select-btn {
            width: 100%;
            padding: 14px;
            margin-bottom: 16px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            letter-spacing: 1px;
            text-transform: uppercase;
            border: 1px dashed var(--border-color);
            background: transparent;
            color: var(--text-dim);
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .select-btn:hover {
            border-color: var(--neon-cyan);
            border-style: solid;
            color: var(--neon-cyan);
            background: rgba(0, 245, 255, 0.05);
        }

        .action-btn {
            width: 100%;
            padding: 20px;
            margin-bottom: 12px;
            font-family: 'Orbitron', sans-serif;
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 2px;
            text-transform: uppercase;
            border: none;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            transition: all 0.3s ease;
        }

        .action-btn.primary {
            background: linear-gradient(135deg, rgba(0, 245, 255, 0.2), rgba(255, 0, 255, 0.1));
            color: var(--neon-cyan);
            border: 1px solid var(--neon-cyan);
        }

        .action-btn.primary:hover {
            background: linear-gradient(135deg, rgba(0, 245, 255, 0.3), rgba(255, 0, 255, 0.2));
            box-shadow: 0 0 30px rgba(0, 245, 255, 0.4), inset 0 0 30px rgba(0, 245, 255, 0.1);
            transform: translateY(-2px);
        }

        .action-btn.secondary {
            background: rgba(255, 0, 255, 0.1);
            color: var(--neon-magenta);
            border: 1px solid var(--neon-magenta);
        }

        .action-btn.secondary:hover {
            background: rgba(255, 0, 255, 0.2);
            box-shadow: 0 0 30px rgba(255, 0, 255, 0.4), inset 0 0 30px rgba(255, 0, 255, 0.1);
            transform: translateY(-2px);
        }

        .action-btn span {
            position: relative;
            z-index: 1;
        }

        /* Usage info */
        .usage-panel {
            margin-top: 20px;
            padding: 16px;
            background: rgba(0, 245, 255, 0.05);
            border: 1px solid var(--border-color);
            display: none;
        }

        .usage-panel.visible {
            display: block;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .usage-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 10px;
            letter-spacing: 2px;
            color: var(--neon-cyan);
            margin-bottom: 12px;
        }

        .usage-bar {
            height: 4px;
            background: rgba(0, 0, 0, 0.4);
            margin-bottom: 12px;
            overflow: hidden;
        }

        .usage-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--neon-cyan), var(--neon-magenta));
            transition: width 0.5s ease;
        }

        .usage-stats {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: var(--text-dim);
        }

        .usage-stats span {
            color: var(--neon-cyan);
        }

        /* Footer decoration */
        .footer-line {
            margin-top: 40px;
            text-align: center;
            font-size: 10px;
            letter-spacing: 3px;
            color: var(--text-dim);
        }

        .footer-line::before,
        .footer-line::after {
            content: '//';
            color: var(--neon-cyan);
            margin: 0 10px;
        }

        /* Responsive */
        @media (max-width: 500px) {
            .checkbox-grid {
                grid-template-columns: 1fr;
            }
            .btn-row {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="logo">TRANSLATOR</div>
            <div class="subtitle">Comment <span>→</span> Any Language</div>
        </div>

        <!-- API Config -->
        <div class="card">
            <div class="card-header">
                <div class="card-icon"></div>
                <div class="card-title">API Configuration</div>
            </div>
            <div class="card-body">
                <label for="apiKey">DeepL API Key</label>
                <input type="text" id="apiKey" placeholder="Enter your API key...">
                <div id="apiKeyStatus" class="status warning">
                    <div class="status-dot"></div>
                    <span>Get your free API key at deepl.com/pro-api</span>
                </div>
            </div>
        </div>

        <!-- Target Language -->
        <div class="card">
            <div class="card-header">
                <div class="card-icon"></div>
                <div class="card-title">Target Language</div>
            </div>
            <div class="card-body">
                <select id="targetLanguage">
                    <option value="EN-US">English (US)</option>
                    <option value="EN-GB">English (UK)</option>
                    <option value="DE">Deutsch</option>
                    <option value="FR">Français</option>
                    <option value="ES">Español</option>
                    <option value="IT">Italiano</option>
                    <option value="PT-PT">Português (PT)</option>
                    <option value="PT-BR">Português (BR)</option>
                    <option value="RU">Русский</option>
                    <option value="JA">日本語</option>
                    <option value="ZH">中文</option>
                    <option value="KO">한국어</option>
                    <option value="PL">Polski</option>
                    <option value="NL">Nederlands</option>
                </select>
            </div>
        </div>

        <!-- What to Translate -->
        <div class="card">
            <div class="card-header">
                <div class="card-icon"></div>
                <div class="card-title">What to Translate</div>
            </div>
            <div class="card-body">
                <div class="checkbox-grid">
                    <label class="checkbox-item">
                        <input type="checkbox" id="translateComments" checked>
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">// Comments</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="translateLogs" checked>
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">console.log()</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="translatePrints" checked>
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">print()</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="translateErrors" checked>
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">throw Error()</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="translateStrings">
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">"All strings"</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="translatePlainText" checked>
                        <span class="checkbox-box"></span>
                        <span class="checkbox-label">Plain text files</span>
                    </label>
                </div>
            </div>
        </div>

        <!-- Mode -->
        <div class="card">
            <div class="card-header">
                <div class="card-icon"></div>
                <div class="card-title">Mode</div>
            </div>
            <div class="card-body">
                <select id="mode">
                    <option value="preview">Preview Changes (Diff View)</option>
                    <option value="replace">Replace Directly</option>
                </select>
            </div>
        </div>

        <!-- Utility buttons -->
        <div class="btn-row">
            <button class="btn" id="checkUsageBtn">Check Usage</button>
            <button class="btn" id="saveBtn">Save Settings</button>
        </div>

        <!-- Usage Panel -->
        <div id="usageInfo" class="usage-panel">
            <div class="usage-title">API USAGE</div>
            <div class="usage-bar">
                <div class="usage-bar-fill" id="usageBarFill" style="width: 0%"></div>
            </div>
            <div class="usage-stats">
                <span id="usageUsed">0</span> / <span id="usageLimit">500,000</span> characters
            </div>
        </div>

        <!-- Actions -->
        <div class="actions-section">
            <button class="select-btn" id="selectFilesBtn">[ Select Files... ]</button>
            <button class="action-btn primary" id="translateProjectBtn">
                <span>⚡ Translate Whole Project</span>
            </button>
            <button class="action-btn secondary" id="translateSelectedBtn">
                <span>◈ Translate Selected Files</span>
            </button>
        </div>

        <div class="footer-line">POWERED BY DEEPL</div>
    </div>

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
                document.getElementById('translatePlainText').checked = settings.translatePlainText !== false;
                document.getElementById('mode').value = settings.mode || 'preview';

                // Update API key status with new UI
                const apiKeyStatus = document.getElementById('apiKeyStatus');
                if (settings.apiKey && settings.apiKey.trim() !== '') {
                    apiKeyStatus.className = 'status success';
                    apiKeyStatus.innerHTML = '<div class="status-dot"></div><span>✓ API key configured</span>';
                } else {
                    apiKeyStatus.className = 'status warning';
                    apiKeyStatus.innerHTML = '<div class="status-dot"></div><span>Get your free API key at deepl.com/pro-api</span>';
                }
            }

            if (message.type === 'settingsSaved') {
                const apiKeyStatus = document.getElementById('apiKeyStatus');
                apiKeyStatus.className = 'status success';
                apiKeyStatus.innerHTML = '<div class="status-dot"></div><span>✓ Settings saved successfully</span>';
            }

            if (message.type === 'usage') {
                const usage = message.usage;
                const usagePanel = document.getElementById('usageInfo');
                usagePanel.classList.add('visible');

                // Update progress bar
                document.getElementById('usageBarFill').style.width = usage.percentage + '%';
                document.getElementById('usageUsed').textContent = usage.count.toLocaleString();
                document.getElementById('usageLimit').textContent = usage.limit.toLocaleString();
            }
        });

        // Select files button
        document.getElementById('selectFilesBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectFiles' });
        });

        // Translate whole project button
        document.getElementById('translateProjectBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'translateProject' });
        });

        // Translate selected files button
        document.getElementById('translateSelectedBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'translateSelected' });
        });

        // Check usage button
        document.getElementById('checkUsageBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'checkUsage' });
        });

        // Auto-save API key when it changes
        document.getElementById('apiKey').addEventListener('blur', () => {
            const apiKey = document.getElementById('apiKey').value;
            if (apiKey && apiKey.trim() !== '') {
                const settings = {
                    apiKey: apiKey,
                    targetLanguage: document.getElementById('targetLanguage').value,
                    translateComments: document.getElementById('translateComments').checked,
                    translateLogs: document.getElementById('translateLogs').checked,
                    translatePrints: document.getElementById('translatePrints').checked,
                    translateErrors: document.getElementById('translateErrors').checked,
                    translateStrings: document.getElementById('translateStrings').checked,
                    translatePlainText: document.getElementById('translatePlainText').checked,
                    mode: document.getElementById('mode').value,
                };
                vscode.postMessage({ type: 'saveSettings', settings });
            }
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
                translatePlainText: document.getElementById('translatePlainText').checked,
                mode: document.getElementById('mode').value,
            };
            vscode.postMessage({ type: 'saveSettings', settings });
        });
    </script>
</body>
</html>`;
    }
}
