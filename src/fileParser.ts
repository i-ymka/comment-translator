import * as vscode from 'vscode';

export enum ContentType {
    COMMENT = 'comment',
    LOG = 'log',
    PRINT = 'print',
    ERROR = 'error',
    STRING = 'string',
    PLAIN_TEXT = 'plainText',
}

export interface ExtractedContent {
    type: ContentType;
    text: string;
    line: number;
    startChar: number;
    endChar: number;
    fullMatch: string; // The entire matched pattern (e.g., "console.log('text')")
}

export class FileParser {
    public async extractContent(
        document: vscode.TextDocument,
        options: {
            comments?: boolean;
            logs?: boolean;
            prints?: boolean;
            errors?: boolean;
            strings?: boolean;
            plainText?: boolean;
        }
    ): Promise<ExtractedContent[]> {
        const content: ExtractedContent[] = [];
        const text = document.getText();
        const languageId = document.languageId;

        console.log(`[FileParser] Extracting from document with ${text.length} chars, ${text.split('\n').length} lines, language: ${languageId}`);

        // Extract comments
        if (options.comments) {
            const comments = this.extractComments(text);
            console.log(`[FileParser] Found ${comments.length} comments`);
            content.push(...comments);
        }

        // Extract logs
        if (options.logs) {
            const logs = this.extractLogs(text);
            console.log(`[FileParser] Found ${logs.length} logs`);
            content.push(...logs);
        }

        // Extract prints
        if (options.prints) {
            const prints = this.extractPrints(text);
            console.log(`[FileParser] Found ${prints.length} prints`);
            content.push(...prints);
        }

        // Extract error messages
        if (options.errors) {
            const errors = this.extractErrors(text);
            console.log(`[FileParser] Found ${errors.length} errors`);
            content.push(...errors);
        }

        // Extract string literals (if enabled and not covered by other options)
        if (options.strings) {
            const strings = this.extractStrings(text, content);
            console.log(`[FileParser] Found ${strings.length} strings`);
            content.push(...strings);
        }

        // Extract plain text lines (only for text-like files)
        if (options.plainText && this.isPlainTextFile(languageId, document.uri.fsPath)) {
            const plainTexts = this.extractPlainText(text, content);
            console.log(`[FileParser] Found ${plainTexts.length} plain text lines`);
            content.push(...plainTexts);
        }

        console.log(`[FileParser] Total extracted: ${content.length} items`);

        // Sort by position
        content.sort((a, b) => {
            if (a.line !== b.line) {
                return a.line - b.line;
            }
            return a.startChar - b.startChar;
        });

        return content;
    }

    private extractComments(text: string): ExtractedContent[] {
        const results: ExtractedContent[] = [];
        const lines = text.split('\n');

        // Extract single-line comments
        // Patterns for different comment styles:
        // - // for JS/TS/C/C++/Java/etc (but not URLs like http://)
        // - # for Python/Ruby/Shell (but not shebang #! or hex colors #fff)
        // - -- for SQL/Lua
        lines.forEach((line, lineIndex) => {
            // Skip shebang lines
            if (line.trim().startsWith('#!')) {
                return;
            }

            // Try // comments (but not URLs)
            let singleMatch = /(?<!:)\/\/\s*(.+?)$/.exec(line);

            // If no // comment, try # comments (but not shebang or hex colors)
            if (!singleMatch) {
                // Match # only if it's at start of line (with optional whitespace) or after code
                singleMatch = /(?:^|\s)#\s+(.+?)$/.exec(line);
            }

            // Try -- comments for SQL/Lua
            if (!singleMatch) {
                singleMatch = /--\s*(.+?)$/.exec(line);
            }

            if (singleMatch) {
                const commentText = singleMatch[1].trim();
                // Skip very short comments and comments that look like code
                if (commentText.length > 1 && this.isNonEnglish(commentText)) {
                    results.push({
                        type: ContentType.COMMENT,
                        text: commentText,
                        line: lineIndex,
                        startChar: singleMatch.index,
                        endChar: singleMatch.index + singleMatch[0].length,
                        fullMatch: singleMatch[0],
                    });
                }
            }
        });

        // Extract multi-line comments
        let match: RegExpExecArray | null;
        const multiPattern = /\/\*([^*]|\*(?!\/))*\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''|<!--[\s\S]*?-->/g;
        while ((match = multiPattern.exec(text)) !== null) {
            const commentText = match[0]
                .replace(/^\/\*|\*\/$/g, '')
                .replace(/^"""|"""$/g, '')
                .replace(/^'''|'''$/g, '')
                .replace(/^<!--|-->$/g, '')
                .trim();

            if (commentText.length > 1 && this.isNonEnglish(commentText)) {
                const position = this.getPosition(text, match.index);
                results.push({
                    type: ContentType.COMMENT,
                    text: commentText,
                    line: position.line,
                    startChar: position.char,
                    endChar: position.char + match[0].length,
                    fullMatch: match[0],
                });
            }
        }

        return results;
    }

    private extractLogs(text: string): ExtractedContent[] {
        // Log statements: console.log, logger.info, log.debug, etc.
        const pattern = /(?:console|logger|log|logging)\.(?:log|info|debug|warn|error|trace)\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
        return this.extractByPattern(text, pattern, ContentType.LOG);
    }

    private extractPrints(text: string): ExtractedContent[] {
        // Print statements: print(), printf(), println(), echo, puts, fmt.Println
        const pattern = /(?:print|printf|println|echo|puts|fmt\.Println|fmt\.Printf|System\.out\.println)\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
        return this.extractByPattern(text, pattern, ContentType.PRINT);
    }

    private extractErrors(text: string): ExtractedContent[] {
        // Error messages: throw new Error(), raise Exception(), panic!()
        const pattern = /(?:throw\s+new\s+(?:Error|Exception)|raise\s+(?:Exception|ValueError|TypeError|RuntimeError)|panic!)\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
        return this.extractByPattern(text, pattern, ContentType.ERROR);
    }

    private extractStrings(text: string, existingContent: ExtractedContent[]): ExtractedContent[] {
        const results: ExtractedContent[] = [];
        // String literals (generic): "...", '...', `...`
        const pattern = /(['"`])((?:\\.|(?!\1).)*?)\1/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
            const stringText = match[2];

            // Skip empty strings and very short strings
            if (!stringText || stringText.length < 2) {
                continue;
            }

            // Skip if already extracted by other patterns
            const position = this.getPosition(text, match.index);
            const matchLength = match[0].length;
            const alreadyExtracted = existingContent.some(
                (item) =>
                    item.line === position.line &&
                    item.startChar <= position.char &&
                    item.endChar >= position.char + matchLength
            );

            if (!alreadyExtracted && this.isNonEnglish(stringText)) {
                results.push({
                    type: ContentType.STRING,
                    text: stringText,
                    line: position.line,
                    startChar: position.char,
                    endChar: position.char + matchLength,
                    fullMatch: match[0],
                });
            }
        }

        return results;
    }

    private extractPlainText(text: string, existingContent: ExtractedContent[]): ExtractedContent[] {
        const results: ExtractedContent[] = [];
        const lines = text.split('\n');

        lines.forEach((line, lineIndex) => {
            const trimmedLine = line.trim();

            // Skip empty lines
            if (trimmedLine.length === 0) {
                return;
            }

            // Check if this line contains non-English text
            if (!this.isNonEnglish(trimmedLine)) {
                return;
            }

            // Check if this line is already covered by other extractions
            const alreadyCovered = existingContent.some(
                (item) => item.line === lineIndex
            );

            if (!alreadyCovered) {
                results.push({
                    type: ContentType.PLAIN_TEXT,
                    text: trimmedLine,
                    line: lineIndex,
                    startChar: line.indexOf(trimmedLine),
                    endChar: line.indexOf(trimmedLine) + trimmedLine.length,
                    fullMatch: trimmedLine,
                });
            }
        });

        return results;
    }

    private isPlainTextFile(languageId: string, filePath: string): boolean {
        // Language IDs that are considered plain text
        const plainTextLanguages = [
            'plaintext',
            'markdown',
            'text',
            'restructuredtext',
            'asciidoc',
            'log',
        ];

        if (plainTextLanguages.includes(languageId)) {
            return true;
        }

        // Also check file extension for files without proper language detection
        const fileName = filePath.split('/').pop() || '';
        const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';

        // Plain text file extensions
        const plainTextExtensions = ['txt', 'text', 'md', 'markdown', 'rst', 'adoc', 'log'];

        // Files without extension are treated as plain text
        if (!ext) {
            console.log(`[FileParser] File without extension treated as plain text: ${filePath}`);
            return true;
        }

        return plainTextExtensions.includes(ext);
    }

    private extractByPattern(
        text: string,
        pattern: RegExp,
        type: ContentType
    ): ExtractedContent[] {
        const results: ExtractedContent[] = [];
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
            const stringText = match[2]; // The captured string content
            if (stringText && stringText.length > 0 && this.isNonEnglish(stringText)) {
                const position = this.getPosition(text, match.index);
                results.push({
                    type,
                    text: stringText,
                    line: position.line,
                    startChar: position.char,
                    endChar: position.char + match[0].length,
                    fullMatch: match[0],
                });
            }
        }

        return results;
    }

    private getPosition(text: string, offset: number): { line: number; char: number } {
        const lines = text.substring(0, offset).split('\n');
        return {
            line: lines.length - 1,
            char: lines[lines.length - 1].length,
        };
    }

    private isNonEnglish(text: string): boolean {
        // Skip if text is empty or only whitespace
        if (!text || text.trim().length === 0) {
            return false;
        }

        // Check if text contains non-ASCII characters
        // This will catch Cyrillic, Chinese, Japanese, Arabic, Korean, Hebrew, etc.
        // Range includes all Unicode characters above ASCII (0x7F)
        // eslint-disable-next-line no-control-regex
        const hasNonAscii = /[^\x00-\x7F]/.test(text);

        if (hasNonAscii) {
            console.log(`[FileParser] Found non-English text: "${text.substring(0, 50)}..."`);
        }

        return hasNonAscii;
    }

    public async getFilesToProcess(scope: 'currentFile' | 'wholeProject', showAll: boolean = false): Promise<vscode.Uri[]> {
        if (scope === 'currentFile') {
            // First try active text editor
            let editor = vscode.window.activeTextEditor;

            // If active editor is not a code file (e.g., settings panel), find the most recent code file
            if (!editor || editor.document.uri.scheme !== 'file') {
                // Look through all visible editors for a file
                const visibleEditors = vscode.window.visibleTextEditors;
                editor = visibleEditors.find(e => e.document.uri.scheme === 'file');

                // If still not found, look through all open text documents
                if (!editor) {
                    const textDocuments = vscode.workspace.textDocuments;
                    const fileDocument = textDocuments.find(doc => doc.uri.scheme === 'file');
                    if (fileDocument) {
                        return [fileDocument.uri];
                    }
                }
            }

            if (editor) {
                return [editor.document.uri];
            }
            return [];
        }

        // Get all files in workspace
        const config = vscode.workspace.getConfiguration('commentTranslator');
        const excludePatterns = config.get<string[]>('excludePatterns', []);

        console.log(`[File Parser] Workspace folders:`, vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(', '));
        console.log(`[File Parser] Searching for files, excluding: ${excludePatterns.join(', ') || '(none)'}`);

        // Use empty exclude pattern if none configured
        const excludeGlob = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
        const files = await vscode.workspace.findFiles('**/*', excludeGlob);

        console.log(`[File Parser] Found ${files.length} files before filtering`);

        // Log ALL files found to help debug
        if (files.length <= 20) {
            console.log(`[File Parser] All files found:`, files.map(f => f.fsPath).join('\n'));
        }

        // Filter only text files (exclude binary files)
        let textFiles = files.filter((file) => {
            const isText = this.isTextFile(file.fsPath);
            if (!isText) {
                console.log(`[File Parser] Excluded (not text): ${file.fsPath}`);
            }
            return isText;
        });

        // If not showing all, filter out IDE/sensitive files
        if (!showAll) {
            textFiles = textFiles.filter((file) => {
                const isSensitive = this.isSensitiveOrIDEFile(file.fsPath);
                if (isSensitive) {
                    console.log(`[File Parser] Excluded (sensitive/IDE): ${file.fsPath}`);
                }
                return !isSensitive;
            });
        }

        console.log(`[File Parser] Found ${textFiles.length} text files after filtering (showAll: ${showAll})`);
        console.log(`[File Parser] Final files:`, textFiles.map(f => f.fsPath).join('\n'));

        return textFiles;
    }

    private isSensitiveOrIDEFile(filePath: string): boolean {
        const sensitivePaths = [
            // IDE files
            '/.idea/',
            '/.vscode/',
            '/.vs/',
            '/.eclipse/',
            '/.settings/',
            // Sensitive files (but not .example variants)
            '/.env',
            '/credentials.',
            '/secrets.',
            '/.aws/',
            '/.ssh/',
            // Cache/temp
            '/__pycache__/',
            '/.pytest_cache/',
            '/.mypy_cache/',
            '/.tox/',
            '/.coverage',
        ];

        // Check if file path contains any sensitive patterns
        for (const pattern of sensitivePaths) {
            if (filePath.includes(pattern)) {
                // Allow .env.example, .env.template, etc.
                if (pattern === '/.env' && (filePath.includes('.env.example') || filePath.includes('.env.template'))) {
                    return false;
                }
                return true;
            }
        }

        return false;
    }

    private isTextFile(filePath: string): boolean {
        // Extract filename and extension
        const fileName = filePath.split('/').pop() || '';
        const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';

        // Common text files without extensions or with special names
        const knownTextFiles = [
            'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile',
            'CMakeLists.txt', 'LICENSE', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS',
            '.dockerignore', '.gitignore', '.gitattributes', '.editorconfig',
            '.eslintrc', '.prettierrc', '.babelrc', '.nvmrc', '.ruby-version',
        ];

        // Check if it's a known text file by name
        if (knownTextFiles.some(name => fileName === name || fileName.toLowerCase() === name.toLowerCase())) {
            return true;
        }

        // If no extension, treat as text file (user can choose to exclude later)
        if (!ext) {
            return true;
        }

        const textExtensions = [
            // JavaScript/TypeScript
            'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'vue',
            // Python
            'py', 'pyw', 'pyx', 'pyi',
            // Java/JVM
            'java', 'kt', 'scala', 'groovy',
            // C/C++
            'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
            // C#/.NET
            'cs', 'fs', 'vb',
            // Go
            'go',
            // Rust
            'rs',
            // Ruby
            'rb', 'rake',
            // PHP
            'php', 'phtml',
            // Swift/Objective-C
            'swift', 'm', 'mm',
            // Shell scripts
            'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
            // Web
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
            // Config/Data
            'xml', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
            'gitignore', 'gitattributes', 'dockerignore', 'editorconfig',
            'eslintrc', 'prettierrc', 'babelrc', 'env', 'properties',
            // Docs
            'md', 'markdown', 'rst', 'txt', 'adoc', 'log',
            // SQL & Database
            'sql', 'psql', 'mysql', 'db', 'sqlite', 'sqlite3',
            // Other
            'lua', 'perl', 'vim', 'dart', 'elm', 'ex', 'exs', 'clj', 'cljs',
            'r', 'jl', 'proto', 'thrift',
        ];
        return textExtensions.includes(ext);
    }
}
