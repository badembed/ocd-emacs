# ocd-cli-wrapper — Work Plan

## TL;DR (For humans)

**Что получится:** Консольная утилита `ocd` — однострочная обертка над OpenCode. Отправляет вопрос → потоково выводит ответ в stdout. Поддерживает контекст файлов/папок, буфер обмена, именованные сессии. Компилируется в один бинарник без зависимостей.

**Почему такой подход:** TypeScript + `@opencode-ai/sdk` дает полный контроль над сессиями и стримингом без shell-костылей. `bun build --compile` — нативный бинарник, не требующий Node.js. Именованные сессии (`-s auth`) решают главную боль `opencode -c` — не нужно помнить/копировать `ses_...` ID.

**Что НЕ делает:** TUI, интерактивный режим, плагины, веб-интерфейс, multi-turn в одном вызове. Только один вопрос → один ответ. Сессии — для контекста между вызовами, не для диалога внутри одного запуска.

**Усилие:** ~200 строк TypeScript в одном файле. 11 задач, 3 волны. ~2-3 часа чистой работы.

**Риски:** Совместимость SDK с форком OpenCode (решено через `OCD_SERVER_URL`). `clipboardy` на Linux без X11/Wayland (graceful degradation).

**Ключевые решения:** Именованные сессии вместо `ses_...` ID; `-p` для clipboard; `bun build --compile` для дистрибуции; agent-executed QA без юнит-тестов.

## Scope

### IN

- `ocd "question"` — простой вопрос в новой сессии
- `ocd file.ts "question"` — вопрос с содержимым файла как контекстом
- `ocd folder/ "question"` — вопрос с листингом папки как контекстом
- `ocd -p "question"` — вопрос с текстом из буфера обмена перед вопросом
- `ocd -s <name> "question"` — именованная сессия (авто-создать при первом вызове, возобновить при последующих)
- `ocd --list-sessions` — список всех именованных сессий с датами и количеством сообщений
- Потоковый вывод ответа в реальном времени (символы появляются по мере генерации)
- Код ошибки >0 при неудаче, сообщение об ошибке в stderr
- Поиск OpenCode: `OPENCODE_BIN_PATH` → `OCD_SERVER_URL` → `PATH`
- Комбинации флагов: `-s <name> -p file.ts "question"` — всё вместе
- Кроссплатформенная сборка: macOS arm64/x64 + Linux x64/arm64
- `--help` с полным описанием всех флагов
- Инсталл-скрипт: копирование бинарника в `~/.local/bin/ocd`

### OUT (Must-NOT-Have)

- TUI / интерактивный режим
- Multi-turn диалог в одном вызове
- Поддержка Windows (бинарники не собираются, но код portable)
- Флаги `--model`, `--agent` (используются defaults из opencode config)
- `--command` (slash-commands — оставить для bare `opencode`)
- Авто-определение типа файла по расширению (пользователь явно указывает file/folder/-p)

## Verification strategy

**Agent-executed QA** — без юнит-тестов. Каждый сценарий проверяется запуском собранного бинарника против реального OpenCode.

Инварианты для QA-проверок:
1. Команда без аргументов → показывает help
2. Несуществующий файл → ошибка в stderr, код ≠ 0
3. Пустой вопрос → ошибка "question required"
4. `-s newname` → создает сессию, запись в `~/.ocd/sessions.json`
5. `-s newname` повторно → использует ту же сессию (контекст сохраняется)
6. `-s nonexistent` (реальный `ses_...` ID) → ошибка "Session not found"
7. `-p` без буфера → предупреждение, вопрос отправляется без clipboard
8. Ответ содержит ожидаемый текст (не пустой, не error)
9. `--list-sessions` → таблица с колонками name, id, messages, updated

## Execution strategy

**Волны:** 3 последовательных. Внутри каждой волны задачи зависимы.

**Файл:** один `src/ocd.ts` (~200 LOC). Все зависимости — npm-пакеты.

**Сборка:** `bun build src/ocd.ts --compile --outfile dist/ocd-<platform>-<arch>`

## Todos

### Wave 1: Foundation — проект, CLI, клиент

- [x] 1. `package.json`: Инициализировать проект с зависимостями `@opencode-ai/sdk`, `commander`, `clipboardy`, `@types/node` и скриптами `build`, `build:all`
  - **References:** repo root `/Users/alexantonov/sources/ocd`; `package.json` со скриптами: `"build": "bun build src/ocd.ts --compile --outfile dist/ocd"`, `"build:all": "bun run build:mac && bun run build:linux"`; зависимости: `"@opencode-ai/sdk": "^1.18.0"`, `"commander": "^14.0.0"`, `"clipboardy": "^4.0.0"`; devDependencies: `"@types/node": "^22.0.0"`, `"typescript": "^5.7.0"`
  - **Acceptance:** `bun install` завершается без ошибок. `bun run build` создает бинарник.
  - **QA happy:** `ls dist/ocd` → файл существует и исполняемый
  - **QA failure:** удалить `node_modules`, `bun install` → восстанавливает
  - **Commit:** `chore: initialize ocd project with dependencies`

- [x] 2. `tsconfig.json`: Настроить строгую TypeScript-конфигурацию для Bun
  - **References:** target `ESNext`, module `ESNext`, moduleResolution `bundler`, strict `true`, noUnusedLocals `true`, noUnusedParameters `true`, outDir `dist`, rootDir `src`
  - **Acceptance:** `bun run build` компилируется без ошибок типов
  - **QA happy:** намеренная ошибка типа → `bun run build` падает с понятным сообщением
  - **QA failure:** удалить tsconfig → сборка падает
  - **Commit:** `chore: add strict tsconfig for Bun`

- [x] 3. `src/ocd.ts` — CLI skeleton: Реализовать разбор аргументов через `commander` для всех паттернов вызова
  - **References:** `commander` v14 API: `.argument()`, `.option()`, `.action()`; паттерны: `ocd [path] [question]` (основной), `-p, --paste` (clipboard), `-s, --session <name>` (именованная сессия), `--list-sessions` (список), `--help`; порядок аргументов: позиционные `[path]` и `[question]` в конце; если `path` передан БЕЗ question → `path` это и есть вопрос (обычный вызов `ocd "question"`)
  - **Acceptance:** `bun run src/ocd.ts --help` выводит описание всех флагов. `bun run src/ocd.ts "hello"` выводит "hello" (заглушка main). `bun run src/ocd.ts file.ts "hello"` выводит "file=file.ts, q=hello". `bun run src/ocd.ts -p "hello"` выводит "paste=true, q=hello". `bun run src/ocd.ts -s auth "hello"` выводит "session=auth, q=hello". `bun run src/ocd.ts --list-sessions` выводит "list=true"
  - **QA happy:** каждый паттерн → правильные значения аргументов в stdout
  - **QA failure:** `bun run src/ocd.ts` (без аргументов) → `--help`
  - **Commit:** `feat: add CLI argument parsing with commander`

- [x] 4. `src/ocd.ts` — OpenCode client resolver: Реализовать функцию `resolveClient(): Promise<OpencodeClient>`
  - **References:** `@opencode-ai/sdk` exports: `createOpencode()` (starts server + returns `{client, server}`), `createOpencodeClient({ baseUrl, directory })` (connects to existing server). Приоритет: (1) `process.env.OPENCODE_BIN_PATH` — передать в `createOpencode` как `config.binPath` если поддерживается, или установить `PATH`; (2) `process.env.OCD_SERVER_URL` — использовать `createOpencodeClient({ baseUrl: process.env.OCD_SERVER_URL })`; (3) `createOpencode({ directory: process.cwd() })` — авто-поиск в `PATH`. Все ошибки соединения → понятное сообщение в stderr + process.exit(1)
  - **Acceptance:** с запущенным `opencode serve --port 4096`, `OCD_SERVER_URL=http://localhost:4096 bun run src/ocd.ts "test"` → использует существующий сервер. Без переменных → авто-запуск.
  - **QA happy:** `OCD_SERVER_URL=http://localhost:1 bun run src/ocd.ts "test"` → ошибка соединения в stderr, exit code 1
  - **QA failure:** остановить opencode сервер → авто-запуск создает новый
  - **Commit:** `feat: implement OpenCode client resolver with env-based discovery`

### Wave 2: Features — сессии, контекст, стриминг

- [x] 5. `src/ocd.ts` — Session manager: Реализовать `resolveSession(client, name)` и `listSessions(client)`
  - **References:** `~/.ocd/sessions.json` формат: `{ "name": "ses_abc123", "name2": "ses_def456" }`. Алгоритм `resolveSession`: (1) читать `~/.ocd/sessions.json`, если нет — создать пустой; (2) если `name` начинается с `ses_` — вернуть как есть (прямой ID); (3) если `name` есть в маппинге → `client.session.get({ id: sessions[name] })` для верификации (если 404 — удалить из маппинга, создать новую); (4) если нет → `client.session.create({ title: name })` → сохранить маппинг → вернуть ID. `listSessions`: для каждой записи в маппинге вызвать `client.session.get()` для получения title/time → вывести таблицу: `NAME | SESSION ID | MESSAGES | UPDATED`
  - **Acceptance:** `bun run src/ocd.ts -s test "hello"` → создает сессию, `~/.ocd/sessions.json` содержит `"test": "ses_..."`. Повторный вызов → использует тот же ID.
  - **QA happy:** `bun run src/ocd.ts -s test "follow-up"` → OpenCode видит историю (проверить через `opencode export <sessionID>` или второй ответ ссылается на первый)
  - **QA failure:** удалить `~/.ocd/sessions.json` → следующий `-s test` создает новую сессию
  - **Commit:** `feat: implement named session manager with JSON store`

- [x] 6. `src/ocd.ts` — Context assembly: Реализовать `assembleParts(path, question, paste)`
  - **References:** `session.prompt()` принимает `parts: Array<TextPartInput | FilePartInput>`. `TextPartInput = { type: "text", text: string }`. Правила сборки: (1) Если `path` — файл (проверить `fs.statSync(path).isFile()`) → читать содержимое `fs.readFileSync(path, "utf-8")`, добавить TextPartInput: `"--- File: ${path} ---\n${content}"`; (2) Если `path` — папка → `fs.readdirSync(path)`, список файлов первым уровнем, добавить TextPartInput: `"--- Folder: ${path} ---\n${files.join('\n')}"`; (3) Если `-p` → `clipboardy.readSync()`, добавить TextPartInput: `"--- Clipboard ---\n${clipboardText}"` (если clipboard пустой — stderr warning, не добавлять); (4) question — всегда последним TextPartInput: `{ type: "text", text: question }`. Порядок parts: clipboard (если есть) → file/folder (если есть) → question
  - **Acceptance:** `bun run src/ocd.ts README.md "суммаризируй"` → отправляет parts с содержимым README.md и вопросом. `bun run src/ocd.ts -p "объясни"` → отправляет clipboard + вопрос.
  - **QA happy:** несуществующий путь → stderr "path not found: ...", exit 1
  - **QA failure:** бинарный файл → stderr "cannot read binary file: ...", exit 1 (проверять через `isText` или ловить ошибку кодировки)
  - **Commit:** `feat: implement context assembly (file, folder, clipboard)`

- [x] 7. `src/ocd.ts` — Output streaming: Реализовать `streamResponse(client, sessionID, parts)` с построчным выводом в stdout
  - **References:** `client.session.prompt({ id: sessionID, parts })` возвращает `Promise<{ info: AssistantMessage, parts: Part[] }>`. Но поскольку нам нужен СТРИМИНГ, а `prompt()` ждет полного ответа, используем `promptAsync()` + подписку на SSE-события: (1) Вызвать `client.session.promptAsync({ id: sessionID, parts })`; (2) Подписаться на `client.event.subscribe()` → фильтровать события `message.part.updated` для нашего `sessionID`; (3) Для каждого `part.type === "text"` с дельтой → `process.stdout.write(delta.text)`; (4) Для `part.type === "tool"` → краткий индикатор в stderr: `[tool: ${tool.tool}...]`; (5) Ждать события `session.status` с `status.type === "idle"` → `process.stdout.write("\n")` → завершить. (6) При ошибке → stderr + exit 1. **Важно:** если `promptAsync` недоступен в текущей версии SDK — использовать `prompt()` и выводить финальный текст из parts после завершения (batch mode fallback).
  - **Acceptance:** `bun run src/ocd.ts "say hello in one word"` → выводит ответ посимвольно в реальном времени (или batch если fallback). Не подвисает, не обрезает ответ.
  - **QA happy:** `bun run src/ocd.ts "count to 5" 2>/dev/null` → stdout содержит "1, 2, 3, 4, 5" или эквивалент
  - **QA failure:** прервать процесс Ctrl+C → чистый выход без stack trace
  - **Commit:** `feat: implement streaming output via SSE event subscription`

### Wave 3: Integration, сборка, QA

- [ ] 8. `src/ocd.ts` — Main integration: Связать все компоненты в функции `main()`
  - **References:** Порядок в main: (1) разобрать аргументы; (2) если `--list-sessions` → resolveClient → listSessions → exit 0; (3) валидировать question (если нет → stderr "question required" + exit 1); (4) resolveClient; (5) если `-s` → resolveSession; (6) assembleParts; (7) если нет `-s` → создать анонимную сессию через `client.session.create()`; (8) streamResponse; (9) если `--list-sessions` после ответа → не выводить; (10) process.exit(0) при успехе
  - **Acceptance:** Все паттерны из Scope IN работают при запуске через `bun run src/ocd.ts`
  - **QA happy:** `bun run src/ocd.ts "what is 2+2?"` → выводит "4" в stdout, exit 0
  - **QA failure:** `bun run src/ocd.ts -s bad "q"` где `bad` не существует и не начинается с `ses_` → создает новую сессию (не падает)
  - **Commit:** `feat: integrate all components into main entry point`

- [ ] 9. Build: Настроить `bun build --compile` для macOS arm64 и Linux x64
  - **References:** `bun build src/ocd.ts --compile --outfile dist/ocd` собирает под текущую платформу. `--target bun-linux-x64-modern`, `--target bun-darwin-arm64-modern` кросскомпиляция. Скрипты в `package.json`: `"build:mac-arm": "bun build src/ocd.ts --compile --target bun-darwin-arm64-modern --outfile dist/ocd-darwin-arm64"`, `"build:mac-x64": "bun build src/ocd.ts --compile --target bun-darwin-x64-modern --outfile dist/ocd-darwin-x64"`, `"build:linux-x64": "bun build src/ocd.ts --compile --target bun-linux-x64-modern --outfile dist/ocd-linux-x64"`, `"build:linux-arm64": "bun build src/ocd.ts --compile --target bun-linux-arm64-modern --outfile dist/ocd-linux-arm64"`, `"build:all": "bun run build:mac-arm && bun run build:mac-x64 && bun run build:linux-x64 && bun run build:linux-arm64"`. Добавить `dist/` в `.gitignore`.
  - **Acceptance:** `bun run build:mac-arm` создает `dist/ocd-darwin-arm64` — исполняемый Mach-O arm64
  - **QA happy:** `file dist/ocd-darwin-arm64` → Mach-O 64-bit executable arm64; `dist/ocd-darwin-arm64 --help` → выводит help
  - **QA failure:** запустить linux-бинарник на macOS → ошибка "cannot execute binary file"
  - **Commit:** `build: configure cross-platform binary compilation`

- [ ] 10. QA: macOS smoke test — проверить все паттерны на macOS arm64
  - **References:** Запустить собранный `dist/ocd-darwin-arm64`. Проверить: (a) `./dist/ocd-darwin-arm64 "say hi"` → ответ в stdout; (b) `./dist/ocd-darwin-arm64 README.md "суммаризируй"` → ответ учитывает содержимое; (c) `./dist/ocd-darwin-arm64 -p "объясни"` (с текстом в буфере) → ответ учитывает буфер; (d) `./dist/ocd-darwin-arm64 -s qa-test "запомни число 42"` → создает сессию; (e) `./dist/ocd-darwin-arm64 -s qa-test "какое число я просил запомнить?"` → отвечает "42"; (f) `./dist/ocd-darwin-arm64 --list-sessions` → показывает `qa-test`; (g) `./dist/ocd-darwin-arm64 nonexistent "q"` → stderr ошибка, exit ≠ 0
  - **Acceptance:** Все проверки (a)-(g) проходят
  - **QA happy:** см. Acceptance
  - **QA failure:** любая проверка не прошла → починить, пересобрать, перезапустить ВСЕ проверки заново
  - **Commit:** `test: macOS arm64 QA smoke test passed` (или fix-коммиты + затем этот)

- [ ] 11. QA: Linux smoke test — проверить все паттерны на Linux x64
  - **References:** Запустить собранный `dist/ocd-linux-x64` на Linux-машине (или Docker-контейнере с `bun`). Проверить те же сценарии (a)-(g) что и для macOS. Для `-p` проверить с `xclip` и `wl-paste`. Убедиться что `~/.ocd/sessions.json` создается с правильными правами (600).
  - **Acceptance:** Все проверки проходят на Linux x64
  - **QA happy:** `./dist/ocd-linux-x64 "uname -s"` → ответ содержит "Linux"
  - **QA failure:** любая проверка не прошла → починить, пересобрать, перезапустить
  - **Commit:** `test: Linux x64 QA smoke test passed`

## Final verification wave

- [ ] F1. Plan compliance audit: сравнить реализованные фичи с разделом Scope IN. Каждый пункт Scope IN имеет покрытие в Todos 1-8. Каждый пункт Scope OUT отсутствует в коде.
- [ ] F2. Code quality: проверить `src/ocd.ts` — один файл, <300 строк, нет `any`, все ошибки обработаны, `process.exit(1)` при ошибках, понятные сообщения в stderr.
- [ ] F3. Cross-platform: `dist/` содержит 4 бинарника (macOS arm64/x64, Linux x64/arm64). Все проходят `--help` на целевой платформе.
- [ ] F4. Edge cases: несуществующий файл → exit 1; пустой вопрос → exit 1; бинарный файл → exit 1; clipboard пустой → warning + продолжение; OpenCode не найден → exit 1 с инструкцией; `~/.ocd` нет → создается автоматически; `~/.ocd/sessions.json` поврежден → пересоздается.

## Commit strategy

Один коммит на каждую задачу (1-11). Сообщения в формате Conventional Commits:

```
feat: <описание>
fix: <описание>
chore: <описание>
build: <описание>
test: <описание>
```

После каждой задачи — коммит. После каждой волны — убедиться что бинарник работает.

## Success criteria

1. `ocd "простой вопрос"` → ответ в stdout, exit 0
2. `ocd -s myproject "задача"` → создает/возобновляет сессию, контекст сохраняется между вызовами
3. `ocd -p "анализ"` → буфер обмена включен в промпт
4. `ocd file.ts "рефакторинг"` → содержимое файла в контексте
5. `ocd --list-sessions` → таблица сессий
6. Все ошибки → понятное сообщение в stderr, exit code ≠ 0
7. Бинарник запускается без Node.js (только `bun` для сборки)
8. macOS и Linux — идентичное поведение
