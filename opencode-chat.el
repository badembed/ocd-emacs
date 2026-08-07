;;; opencode-chat.el --- Multi-turn chat with OpenCode sessions in Emacs buffers -*- lexical-binding: t; -*-

;; Copyright (C) 2026 opencode-emacs-chat contributors

;; Author: opencode-emacs-chat contributors
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1"))
;; Keywords: tools, processes, convenience
;; URL: https://github.com/opencode-emacs-chat/opencode-chat

;; This file is part of opencode-chat.

;; opencode-chat is free software: you can redistribute it and/or modify
;; it under the terms of the GNU General Public License as published by
;; the Free Software Foundation, either version 3 of the License, or
;; (at your option) any later version.

;; opencode-chat is distributed in the hope that it will be useful,
;; but WITHOUT ANY WARRANTY; without even the implied warranty of
;; MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
;; GNU General Public License for more details.

;; You should have received a copy of the GNU General Public License
;; along with opencode-chat.  If not, see <https://www.gnu.org/licenses/>.

;;; Commentary:

;; opencode-chat turns each Emacs buffer into a multi-turn OpenCode
;; session.  The buffer is backed by a real file under
;; `opencode-chat-sessions-dir' (default `~/.opencode-chat/sessions/'),
;; so sessions are restored automatically when the file is reopened.
;; User prompts and assistant responses live in the same buffer; the
;; boundary is tracked with an invisible text-property (the gptel
;; pattern), so the file remains plain Markdown and is freely editable.

;;; Code:

(require 'json)

;;;###autoload
(defgroup opencode-chat nil
  "Multi-turn chat with OpenCode sessions in Emacs buffers."
  :prefix "opencode-chat-"
  :group 'tools
  :group 'processes
  :link '(url-link "https://github.com/opencode-emacs-chat/opencode-chat"))

(defcustom opencode-chat-ocd-program "ocd"
  "Path or name of the `ocd' executable used as the OpenCode backend."
  :type 'string
  :group 'opencode-chat)

(defcustom opencode-chat-sessions-dir "~/.opencode-chat/sessions/"
  "Directory in which opencode-chat stores per-session Markdown files."
  :type 'directory
  :group 'opencode-chat)

(defcustom opencode-chat-major-mode 'text-mode
  "Major mode used as the parent of `opencode-chat-mode'."
  :type 'function
  :group 'opencode-chat)

(defcustom opencode-chat-auto-approve nil
  "When non-nil, automatically approve permission prompts from `ocd'.
Mirror `ocd''s own default: auto-approve is OFF by default."
  :type 'boolean
  :group 'opencode-chat)

(defcustom opencode-chat-log-level nil
  "Logging verbosity for opencode-chat.
When nil, logging is disabled.  When an integer, higher values mean
more verbose output (interpretation is implementation-defined)."
  :type '(choice integer (const :tag "Disabled" nil))
  :group 'opencode-chat)

;;; Command stubs (real implementations land in todos 8-15).

(defun opencode-chat--local-variables-start ()
  "Return the start of the trailing `Local Variables' block, or nil.
A block counts only when nothing but whitespace follows its `;; End:'
line — so a legacy header block above the transcript is ignored and
the chat body still extends to `point-max'."
  (save-excursion
    (goto-char (point-max))
    (when (re-search-backward "^;; Local Variables:\\s-*$" nil t)
      (let ((beg (match-beginning 0)))
        (goto-char beg)
        (when (and (re-search-forward "^;; End:\\s-*$" nil t)
                   (progn (forward-line 1) t)
                   (looking-at-p "\\s-*\\'"))
          beg)))))

(defun opencode-chat--body-end ()
  "Return the end of the editable chat body (before Local Variables)."
  (or (opencode-chat--local-variables-start) (point-max)))

(defun opencode-chat--body-beg ()
  "Return the start of the editable chat body (after the header).
Never returns a position inside the trailing Local Variables block —
an empty body starts on the blank line immediately before it."
  (save-excursion
    (goto-char (point-min))
    (let ((end (opencode-chat--body-end)))
      (cond
       ((re-search-forward
         ;; Use [ \t]* not \\s-* — the latter matches newlines and would
         ;; leave point on the following blank line, so forward-line
         ;; skips into `;; Local Variables:'.
         "^Type your message and press `C-c C-c` to send\\.[ \t]*$"
         end t)
        (forward-line 1)
        ;; Do not skip blank lines onto the Local Variables line; typing
        ;; there would corrupt `^;; Local Variables:' and break restore.
        (min (point) end))
       ;; Legacy files with Local Variables under the header: body after
       ;; the first `;; End:' that closes that header block.
       ((re-search-forward "^;; End:[ \t]*$" end t)
        (forward-line 1)
        (min (point) end))
       (t (point-min))))))

(defun opencode-chat--goto-body-end ()
  "Move point to the end of the chat body (before Local Variables).
Ensures a newline separates the body from the Local Variables block
so inserts never prefix the `;; Local Variables:' line."
  (let ((lv (opencode-chat--local-variables-start)))
    (goto-char (or lv (point-max)))
    (when (and lv
               (or (= (point) (point-min))
                   (not (eq (char-before) ?\n))))
      (insert "\n"))))

(defun opencode-chat--last-response-end (&optional limit)
  "Return the end position of the last `opencode-response' run.
Search is limited to LIMIT (default body end).  Returns nil when
no response text exists at or before LIMIT.

Text properties move with edits, so this stays correct even if the
integer snapshot in `opencode-chat--bounds' is stale."
  (let* ((limit (min (or limit (opencode-chat--body-end)) (point-max)))
         (pos limit))
    (when (> pos (point-min))
      (unless (get-text-property (1- pos) 'opencode-response)
        (setq pos (or (previous-single-property-change
                       pos 'opencode-response nil (point-min))
                      (point-min))))
      (when (and (> pos (point-min))
                 (get-text-property (1- pos) 'opencode-response))
        (or (next-single-property-change (1- pos) 'opencode-response
                                         nil limit)
            limit)))))

(defun opencode-chat--collect-response-bounds ()
  "Return ((BEG . END) ...) for every `opencode-response' run in the body.
Used when persisting `opencode-chat--bounds' so the file-local snapshot
matches the live text properties after edits."
  (let ((pos (opencode-chat--body-beg))
        (max (opencode-chat--body-end))
        bounds)
    (while (< pos max)
      (if (get-text-property pos 'opencode-response)
          (let ((end (or (next-single-property-change
                          pos 'opencode-response nil max)
                         max)))
            (push (cons pos end) bounds)
            (setq pos end))
        (setq pos (or (next-single-property-change
                       pos 'opencode-response nil max)
                      max))))
    (nreverse bounds)))

(defun opencode-chat--response-run-markers ()
  "Return ((BEG-MARKER . END-MARKER) ...) for each response run.
BEG markers are non-advancing; END markers advance on insert, so
rewriting the Local Variables block can be followed by a stable
re-read of positions via `marker-position'."
  (mapcar
   (lambda (pair)
     (cons (copy-marker (car pair) nil)
           (copy-marker (cdr pair) t)))
   (opencode-chat--collect-response-bounds)))

(defun opencode-chat--prompt-beg (end)
  "Return the start of the user prompt ending at END.

Live source of truth is the `opencode-response' text-property (via
`opencode-chat--last-response-end'), combined with
`opencode-chat--prompt-marker' so a just-sent prompt is not resent.
Falls back to `opencode-chat--body-beg' for a fresh session."
  (or
   (let* ((resp-end (opencode-chat--last-response-end end))
          (sent-end (and (boundp 'opencode-chat--prompt-marker)
                         (markerp opencode-chat--prompt-marker)
                         (marker-position opencode-chat--prompt-marker)))
          (beg (cond
                ((and resp-end sent-end) (max resp-end sent-end))
                (resp-end resp-end)
                (sent-end sent-end)
                (t nil))))
     (when (and beg (<= beg end)) beg))
   (let ((body (opencode-chat--body-beg)))
     (when (<= body end) body))
   (point-min)))

(defun opencode-chat--normalize-prompt (text)
  "Collapse TEXT to a single stdin line for `ocd --stream'.
Newlines would otherwise each become a separate OpenCode turn."
  (string-trim
   (replace-regexp-in-string "[ \t\n\r]+" " " text)))

(defun opencode-chat--remove-local-variables-section ()
  "Delete every `Local Variables' / `End:' block in the buffer.
Used before rewriting a single trailing block so legacy header
copies do not survive beside the canonical footer."
  (save-excursion
    (goto-char (point-min))
    (while (re-search-forward "^;; Local Variables:\\s-*$" nil t)
      (let ((beg (match-beginning 0)))
        (if (re-search-forward "^;; End:\\s-*$" nil t)
            (progn
              (forward-line 1)
              (delete-region beg (point)))
          (goto-char (point-max)))))))

;;;###autoload
(defun opencode-chat-send ()
  "Send the current prompt to the OpenCode subprocess.
With a prefix argument, send the active region.

Without a prefix, send the text after the last assistant response
through the end of the chat body (not merely through point).  This
matters in Evil normal state, where point often rests on the last
response character while the follow-up was typed at EOB.

The prompt is normalized to a single line: `ocd --stream' reads
stdin line-by-line, so embedded newlines would enqueue extra turns."
  (interactive)
  (unless (and (boundp 'opencode-chat--process)
               opencode-chat--process)
    (user-error "opencode-chat-send: no subprocess running"))
  (unless (process-live-p opencode-chat--process)
    (user-error "opencode-chat-send: subprocess has exited"))
  (let* ((prefix current-prefix-arg)
         (use-region (and prefix (use-region-p)))
         (end (if use-region (region-end) (opencode-chat--body-end)))
         (beg (if use-region
                  (region-beginning)
                (opencode-chat--prompt-beg end)))
         (prompt (opencode-chat--normalize-prompt
                  (if (< beg end)
                      (buffer-substring-no-properties beg end)
                    ""))))
    (when (string-empty-p prompt)
      (user-error "opencode-chat-send: nothing to send"))
    (process-send-string opencode-chat--process (concat prompt "\n"))
    (opencode-chat--goto-body-end)
    (unless (eq (char-before) ?\n)
      (insert "\n"))
    (if (markerp opencode-chat--prompt-marker)
        (set-marker opencode-chat--prompt-marker (point))
      (setq opencode-chat--prompt-marker (point-marker)))
    (setq opencode-chat--sending t)))

;;;###autoload
(defun opencode-chat-abort ()
  "Abort the current in-flight stream without killing the session."
  (interactive)
  (unless (and (boundp 'opencode-chat--process)
               opencode-chat--process)
    (user-error "opencode-chat-abort: no subprocess running"))
  ;; Best-effort: reject any queued permission asks before SIGINT.
  (opencode-chat--reject-pending-permissions)
  (interrupt-process opencode-chat--process)
  (let ((stderr-buf (get-buffer-create "*opencode-chat-stderr*")))
    (with-current-buffer stderr-buf
      (goto-char (point-max))
      (insert (format "[%s] abort: SIGINT sent\n"
                      (format-time-string "%H:%M:%S"))))))

;;;###autoload
(defun opencode-chat-rename-session (new-name)
  "Rename the current session to NEW-NAME.
Prompt interactively with completion against existing session files
(basename without the `.md' extension).  When called non-interactively
with a string NEW-NAME, use it directly.

If NEW-NAME equals the current session name, signal no-op with a
\"same name\" message.  If NEW-NAME already exists as a session file,
signal a user-error.  If a subprocess is mid-stream (the buffer-local
`opencode-chat--sending' flag is non-nil), abort it via
`opencode-chat-abort' and wait for the process to exit before
proceeding.

On success: `rename-file' the backing file, update the buffer-local
`opencode-chat--session-name', update the file-local var via
`add-file-local-variable', save the buffer, and restart the subprocess
with the new name via `opencode-chat--start-process'.  Returns NEW-NAME."
  (interactive
   (list (completing-read "New session name: "
                          #'opencode-chat--list-session-files
                          nil nil nil nil
                          (or (and (boundp 'opencode-chat--session-name)
                                   opencode-chat--session-name)
                              ""))))
  (let* ((current-name (and (boundp 'opencode-chat--session-name)
                            opencode-chat--session-name))
         (sanitized (opencode-chat--sanitize-name new-name))
         (old-file (and buffer-file-name buffer-file-name))
         (new-file (and sanitized (not (string-empty-p sanitized))
                        (opencode-chat--session-file-path sanitized)))
         (same-name (and current-name sanitized
                         (string= sanitized current-name))))
    ;; Empty input: nothing to do.
    (unless (and sanitized (not (string-empty-p sanitized)))
      (user-error "opencode-chat-rename-session: new name is empty"))
    (unless old-file
      (user-error "opencode-chat-rename-session: buffer is not file-backed"))
    ;; No-op when the new name matches the current name.  Return
    ;; early so we don't trip the "session already exists" check
    ;; below (the new path equals the old path in this case).
    (if same-name
        (progn
          (message "opencode-chat: same name")
          sanitized)
      ;; Refuse to overwrite an existing session file.
      (when (and new-file (file-exists-p new-file))
        (user-error "opencode-chat-rename-session: session already exists: %s"
                    sanitized))
      ;; If a stream is in flight, abort it and wait for the process
      ;; to exit so the rename is safe (the subprocess holds the
      ;; session name; renaming mid-stream would leave it talking to
      ;; a stale session name).
      (when (and (boundp 'opencode-chat--sending)
                 opencode-chat--sending
                 (boundp 'opencode-chat--process)
                 opencode-chat--process
                 (process-live-p opencode-chat--process))
        (opencode-chat-abort)
        (opencode-chat--wait-for-process-exit opencode-chat--process 5.0))
      ;; Move the file on disk and update the buffer's file
      ;; association.
      (condition-case err
          (progn
            (rename-file old-file new-file 1)
            (set-visited-file-name new-file))
        (error
         (user-error "opencode-chat-rename-session: rename failed: %S" err)))
      ;; Update the buffer-local and file-local session name, then
      ;; save so the new file-local var is persisted to disk.
      (setq opencode-chat--session-name sanitized)
      (add-file-local-variable 'opencode-chat--session-name sanitized)
      (condition-case err
          (save-buffer)
        (error
         (message "opencode-chat: save-buffer after rename failed: %S" err)))
      ;; Restart the subprocess with the new name.  If a process is
      ;; still hanging around (e.g. the abort timeout fired), kill
      ;; it first so `--start-process' can spawn a fresh one.
      (when (and (boundp 'opencode-chat--process)
                 opencode-chat--process
                 (process-live-p opencode-chat--process))
        (delete-process opencode-chat--process)
        (setq opencode-chat--process nil))
      (condition-case err
          (opencode-chat--start-process)
        (error
         (message "opencode-chat: failed to start subprocess after rename: %S"
                  err)))
      sanitized)))

;;;###autoload
(defun opencode-chat-list-sessions ()
  "List all OpenCode sessions known to `ocd'.
Shells out to `opencode-chat-ocd-program' with `-l' and displays the
output in the `*opencode-chat-sessions*' buffer, switching to it so
the user sees the table.

Signals a user-error when `opencode-chat-ocd-program' is not found on
PATH (so the user gets a clear message instead of a confusing shell
error)."
  (interactive)
  (unless (or (file-executable-p opencode-chat-ocd-program)
              (executable-find opencode-chat-ocd-program))
    (user-error "opencode-chat-list-sessions: %s not found on PATH"
                opencode-chat-ocd-program))
  (let ((out-buf (get-buffer-create "*opencode-chat-sessions*")))
    (with-current-buffer out-buf
      (let ((inhibit-read-only t))
        (erase-buffer)))
    (condition-case err
        (let ((exit-code (process-file opencode-chat-ocd-program
                                       nil out-buf nil "-l")))
          (when (and (numberp exit-code) (/= exit-code 0))
            (message "opencode-chat-list-sessions: %s exited with code %s"
                     opencode-chat-ocd-program exit-code)))
      (error
       (with-current-buffer out-buf
         (let ((inhibit-read-only t))
           (erase-buffer)
           (insert (format "opencode-chat-list-sessions: failed to run %s: %S\n"
                           opencode-chat-ocd-program err))))
       (display-buffer out-buf)
       (user-error "opencode-chat-list-sessions: %s" err)))
    (display-buffer out-buf)))

;;;###autoload
(defun opencode-chat-kill-session ()
  "Kill the current OpenCode session.
Sends `quit\\n' to the subprocess stdin, waits up to 5 seconds for it
to exit, then kills the buffer.  If the subprocess does not exit in
time, `delete-process' forces termination before the buffer is killed.

When no subprocess is running, just kills the buffer (with the
`kill-buffer-query-functions' suppressed so Emacs does not prompt)."
  (interactive)
  (let ((proc (and (boundp 'opencode-chat--process)
                   opencode-chat--process)))
    (when (and proc (process-live-p proc))
      (condition-case err
          (process-send-string proc "quit\n")
        (error
         (message "opencode-chat-kill-session: send quit failed: %S" err)))
      (unless (opencode-chat--wait-for-process-exit proc 5.0)
        (message "opencode-chat-kill-session: subprocess did not exit in time, deleting")
        (delete-process proc)))
    ;; Clear the buffer-local handle so the sentinel (if it fires
    ;; later) does not see a stale reference.
    (when (boundp 'opencode-chat--process)
      (setq opencode-chat--process nil))
    ;; Kill the buffer without prompting.  `kill-buffer' runs
    ;; `kill-buffer-query-functions'; bypassing them with
    ;; `unwind-protect' is not safe, so we temporarily clear them.
    (let ((kill-buffer-query-functions nil))
      (kill-buffer (current-buffer)))))

;;;###autoload
(defun opencode-chat-resume ()
  "Resume an existing OpenCode chat session.
Lists session files in `opencode-chat-sessions-dir' and prompts with
`completing-read' for one.  The selected session is opened via
`find-file'; `opencode-chat-mode' auto-activates via `auto-mode-alist'
and triggers `opencode-chat--restore-state' from todo 13, which
resumes the subprocess and restores response-region text properties.

Available via `M-x opencode-chat-resume' (no default keybinding).

Returns the buffer that was opened, or nil when no sessions exist."
  (interactive)
  (let* ((sessions (opencode-chat--list-session-files))
         (choice (and sessions
                      (completing-read
                       "Resume session: "
                       sessions nil t nil nil
                       (car sessions))))
         (file (and choice
                    (opencode-chat--session-file choice))))
    (cond
     ((null sessions)
      (message "no sessions found")
      nil)
     (choice
      (find-file file)
      (current-buffer)))))

;;; Internal variables (buffer-local state).
;; These are declared with `defvar' (not just `setq-local') so that
;; `let' bindings in callers create dynamic bindings visible inside
;; `opencode-chat-mode' even with `lexical-binding: t'.  Special
;; variables are always dynamically scoped.

(defvar opencode-chat--process nil
  "Buffer-local handle to the `ocd' subprocess for the current buffer.")
(make-variable-buffer-local 'opencode-chat--process)

(defvar opencode-chat--pending-output ""
  "Accumulated stdout from the subprocess awaiting parsing/insertion.")
(make-variable-buffer-local 'opencode-chat--pending-output)

(defvar opencode-chat--session-name nil
  "Name of the OpenCode session backing this buffer.
Set by callers (todo 11's `opencode-chat-open') or by file-local
vars (todo 13's restore flow) BEFORE `opencode-chat-mode' activates.
The mode's parent call (`text-mode') invokes `kill-all-local-variables',
so `opencode-chat-mode' saves and restores this value around it.")
(make-variable-buffer-local 'opencode-chat--session-name)

(defvar opencode-chat--session-id nil
  "OpenCode server-side session ID (set by `ocd --stream').")
(make-variable-buffer-local 'opencode-chat--session-id)

(defvar opencode-chat--bounds nil
  "Alist of (BEGIN . END) response region bounds for persistence.
Live prompt detection uses the `opencode-response' text-property;
this alist is a snapshot rewritten from those properties on save.")
(make-variable-buffer-local 'opencode-chat--bounds)

(defvar opencode-chat--created nil
  "Timestamp when this session was first created.")
(make-variable-buffer-local 'opencode-chat--created)

(defvar opencode-chat--sending nil
  "Non-nil while a prompt is in flight to the subprocess.
Set to t by `opencode-chat-send'; cleared by the sentinel/filter
when the response stream completes.  Currently used as a hook for
visual feedback (e.g. mode-line indicators); future todos may add
automatic clearing.")
(make-variable-buffer-local 'opencode-chat--sending)

(defvar opencode-chat--prompt-marker nil
  "Marker at the end of the last sent prompt.
`opencode-chat-send' advances this so the same text is not resent
before the next assistant region is recorded in
`opencode-chat--bounds'.")
(make-variable-buffer-local 'opencode-chat--prompt-marker)

(defvar opencode-chat--permission-queue nil
  "Queue of pending OpenCode permission asks from `ocd --jsonl'.
Each entry is a plist (:id ID :permission TYPE :title TITLE :patterns LIST).")
(make-variable-buffer-local 'opencode-chat--permission-queue)

(defvar opencode-chat--permission-asking nil
  "Non-nil while a permission minibuffer prompt is active.")
(make-variable-buffer-local 'opencode-chat--permission-asking)

;;; Mode and keymap.

;;;###autoload
(defvar opencode-chat-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-c") #'opencode-chat-send)
    (define-key map (kbd "C-c C-k") #'opencode-chat-abort)
    (define-key map (kbd "C-c C-r") #'opencode-chat-rename-session)
    (define-key map (kbd "C-c C-l") #'opencode-chat-list-sessions)
    map)
  "Keymap for `opencode-chat-mode'.")

;;;###autoload
(defvar opencode-chat-mode-hook nil
  "Hook run when entering `opencode-chat-mode'.
Use this hook to install buffer-local setup, font-lock tweaks, etc.")

;;;###autoload
(defun opencode-chat-mode ()
  "Major mode for multi-turn chat with OpenCode sessions.

The buffer is backed by a real file under `opencode-chat-sessions-dir',
so sessions are restored automatically when reopened.  See
`opencode-chat-mode-map' for key bindings.

Derives from the mode named by `opencode-chat-major-mode'
(default `text-mode'); if that variable names a function, it is
called first with `delay-mode-hooks' so its hooks do not fire
before our setup completes."
  (interactive)
  (let ((parent (if (fboundp opencode-chat-major-mode)
                    opencode-chat-major-mode
                  'fundamental-mode))
        ;; Save buffer-local vars that may have been set by
        ;; file-local vars (todo 13) or by callers before the mode
        ;; activates.  The parent mode's `kill-all-local-variables'
        ;; would wipe them, so save them now and restore after.
        ;; `file-local-variables-alist' is also saved because
        ;; `opencode-chat--restore-state' reads from it.
        (saved-session-name (and (local-variable-p 'opencode-chat--session-name)
                                 opencode-chat--session-name))
        (saved-session-id (and (local-variable-p 'opencode-chat--session-id)
                               opencode-chat--session-id))
        (saved-bounds (and (local-variable-p 'opencode-chat--bounds)
                           opencode-chat--bounds))
        (saved-created (and (local-variable-p 'opencode-chat--created)
                            opencode-chat--created))
        (saved-alist (and (local-variable-p 'file-local-variables-alist)
                          file-local-variables-alist)))
    ;; Initialize the parent mode (delay its hooks until we finish setup).
    (let ((delay-mode-hooks t))
      (funcall parent))
    ;; The parent mode may have made `delay-mode-hooks' buffer-local
    ;; and set it to t; reset it so our `run-mode-hooks' call below
    ;; actually fires the hooks (otherwise it's a no-op).
    (setq delay-mode-hooks nil)
    ;; Restore the saved vars that the parent mode's
    ;; `kill-all-local-variables' just cleared.
    (when saved-session-name
      (setq-local opencode-chat--session-name saved-session-name))
    (when saved-session-id
      (setq-local opencode-chat--session-id saved-session-id))
    (when saved-bounds
      (setq-local opencode-chat--bounds saved-bounds))
    (when saved-created
      (setq-local opencode-chat--created saved-created))
    (when saved-alist
      (setq-local file-local-variables-alist saved-alist))
    ;; In batch mode, `find-file-noselect' does not call
    ;; `hack-local-variables', so file-local vars are not parsed.
    ;; Call it here if the buffer is file-backed and the alist is
    ;; empty, so `opencode-chat--restore-state' can read the vars.
    ;; In interactive mode this is a no-op (vars already parsed).
    (when (and buffer-file-name
               (null file-local-variables-alist))
      (hack-local-variables))
    ;; Override mode name and keymap.
    (setq major-mode 'opencode-chat-mode)
    (setq mode-name "OpenCode-Chat")
    (use-local-map opencode-chat-mode-map)
    ;; Initialize buffer-local state.  The variables are already
    ;; buffer-local (via `make-variable-buffer-local'), so plain `setq'
    ;; sets the buffer-local value.  Restore from saved values where
    ;; available so file-local vars survive the parent mode call.
    (setq opencode-chat--process nil)
    (setq opencode-chat--pending-output "")
    (setq opencode-chat--session-id (or saved-session-id nil))
    (setq opencode-chat--bounds (or saved-bounds nil))
    (setq opencode-chat--created (or saved-created nil))
    (setq opencode-chat--sending nil)
    (setq opencode-chat--prompt-marker nil)
    ;; For file-backed buffers without a session name (e.g. a raw
    ;; `find-file' + `opencode-chat-mode' without going through
    ;; `opencode-chat-open'), derive the session name from the file
    ;; name so `opencode-chat--save-state' can persist it on save.
    (when (and (null opencode-chat--session-name)
               buffer-file-name)
      (setq opencode-chat--session-name
            (file-name-base buffer-file-name)))
    ;; Set creation timestamp for fresh file-backed buffers so the
    ;; file-local var is always a string when persisted.
    (when (and (null opencode-chat--created)
               buffer-file-name)
      (setq opencode-chat--created
            (format-time-string "%Y-%m-%dT%H:%M:%S%z")))
    ;; Install state-persistence hooks (buffer-local).
    ;; `write-file-functions' persists session state on save.
    ;; `opencode-chat-mode-hook' restores state on mode activation.
    (add-hook 'write-file-functions #'opencode-chat--save-state nil t)
    (add-hook 'opencode-chat-mode-hook #'opencode-chat--restore-state nil t)
    (run-mode-hooks 'opencode-chat-mode-hook)
    ;; Start the subprocess once the mode is fully initialized, but only
    ;; when a session name is already known AND no process is already
    ;; running.  `opencode-chat--restore-state' (from the hook above)
    ;; may have already started one for restored sessions.
    (when (and (boundp 'opencode-chat--session-name)
               opencode-chat--session-name
               (null opencode-chat--process))
      (opencode-chat--start-process))))

;; Register the parent mode relationship so `derived-mode-p' works.
(put 'opencode-chat-mode 'derived-mode-parent 'text-mode)

;;;###autoload
(add-to-list 'auto-mode-alist "\\.opencode-chat/sessions/.*\\.md\\'")

;;; Subprocess lifecycle.

(defun opencode-chat--start-process ()
  "Start the `ocd' subprocess for the current buffer.
Returns the process object.  Stores it in the buffer-local
`opencode-chat--process' and installs the filter and sentinel.

Signals `user-error' if `opencode-chat--session-name' is nil; callers
that activate the mode before a session name is known should guard
the call (see `opencode-chat-mode')."
  (unless (and (boundp 'opencode-chat--session-name)
               opencode-chat--session-name)
    (user-error "opencode-chat--session-name is nil; cannot start process"))
  (let* ((expanded (expand-file-name opencode-chat-ocd-program))
         ;; If the expanded path is not an executable file (e.g.  the
         ;; default bare name "ocd" which `expand-file-name' resolves
         ;; relative to `default-directory' rather than `$PATH'), fall
         ;; back to the original value so `make-process' can resolve it
         ;; via PATH.
         (ocd-program (if (file-executable-p expanded)
                          expanded
                        opencode-chat-ocd-program))
         (stderr-buf (get-buffer-create "*opencode-chat-stderr*"))
         (command (append (list ocd-program
                                "--stream"
                                "--jsonl"
                                "--name"
                                opencode-chat--session-name)
                          (when opencode-chat-auto-approve
                            (list "--auto"))))
         (process (make-process
                   :name "opencode-chat"
                   :buffer (current-buffer)
                   :coding '(utf-8 . no-conversion)
                   :command command
                   :stderr stderr-buf
                   :connection-type 'pipe
                   :noquery t)))
    (setq opencode-chat--process process)
    (set-process-filter process #'opencode-chat--process-filter)
    (set-process-sentinel process #'opencode-chat--process-sentinel)
    process))

(defun opencode-chat--process-filter (proc output)
  "Process filter for the `opencode-chat' subprocess.
Parses JSON Lines from OUTPUT (one JSON object per line), accumulates
partial lines in the buffer-local `opencode-chat--pending-output',
and inserts text chunks into the process buffer with the
`opencode-response' text-property.

Always switches to `(process-buffer PROC)' — filters are not
guaranteed to run with that buffer current.

Each line is one of:
- `{\"type\":\"text\",\"text\":\"...\"}' -- text chunk of the assistant's
  response; concatenated into the current response region.
- `{\"type\":\"session_id\",\"id\":\"...\"}' -- the OpenCode server-side
  session ID; stored in `opencode-chat--session-id'.
- `{\"type\":\"permission\",...}' -- permission ask; answered via
  minibuffer and a JSONL `permission_reply' on stdin.
- Other types (reasoning, tool calls, etc.) -- logged to
  `*opencode-chat-stderr*' and skipped."
  (let ((buf (process-buffer proc)))
    (when (buffer-live-p buf)
      (with-current-buffer buf
        (let ((stderr-buf (get-buffer-create "*opencode-chat-stderr*"))
              (combined (concat opencode-chat--pending-output output)))
          ;; Find the position of the last newline in the combined string.
          ;; Everything before it is complete lines; everything after is
          ;; partial (kept for the next filter call).
          (let ((last-newline (string-match "\n[^\n]*\\'" combined)))
            (if (null last-newline)
                ;; No newline at all: the entire combined string is partial.
                (setq opencode-chat--pending-output combined)
              ;; Process complete lines (everything before the last newline).
              (let* ((complete (substring combined 0 last-newline))
                     (partial (substring combined (1+ last-newline))))
                (setq opencode-chat--pending-output partial)
                (dolist (line (split-string complete "\n" t))
                  (opencode-chat--process-line line stderr-buf))))))))))

(defun opencode-chat--send-permission-reply (proc id response)
  "Send a JSONL permission_reply for ID with RESPONSE to PROC."
  (when (and proc (process-live-p proc))
    (process-send-string
     proc
     (concat (json-encode
              `((type . "permission_reply")
                (id . ,id)
                (response . ,response)))
             "\n"))))

(defun opencode-chat--reject-pending-permissions ()
  "Reject queued permission asks and clear the permission queue.
Sends `reject' for each pending id when the subprocess is live."
  (let ((proc opencode-chat--process)
        (queue opencode-chat--permission-queue))
    (setq opencode-chat--permission-queue nil)
    (dolist (ask queue)
      (opencode-chat--send-permission-reply
       proc (plist-get ask :id) "reject"))))

(defun opencode-chat--drain-permission-queue ()
  "Prompt for the next queued permission ask, if any."
  (when (and (not opencode-chat--permission-asking)
             opencode-chat--permission-queue)
    (setq opencode-chat--permission-asking t)
    (let* ((ask (pop opencode-chat--permission-queue))
           (proc opencode-chat--process)
           (id (plist-get ask :id))
           (title (or (plist-get ask :title)
                      (plist-get ask :permission)
                      "permission"))
           (patterns (plist-get ask :patterns))
           (prompt (if patterns
                       (format "%s [%s]" title
                               (mapconcat #'identity patterns ", "))
                     title))
           (stderr-buf (get-buffer-create "*opencode-chat-stderr*"))
           response)
      (unwind-protect
          (setq response
                (condition-case nil
                    (let ((choice
                           (read-multiple-choice
                            (format "OpenCode permission: %s " prompt)
                            '((?y "once" "approve once")
                              (?a "always" "approve always")
                              (?n "reject" "reject")))))
                      (pcase (nth 1 choice)
                        ("once" "once")
                        ("always" "always")
                        (_ "reject")))
                  (quit "reject")))
        (setq opencode-chat--permission-asking nil)
        (opencode-chat--send-permission-reply proc id (or response "reject"))
        (with-current-buffer stderr-buf
          (goto-char (point-max))
          (insert (format "[%s] permission %s → %s\n"
                          (format-time-string "%H:%M:%S")
                          id
                          (or response "reject"))))
        (when opencode-chat--permission-queue
          (run-at-time 0 nil #'opencode-chat--drain-permission-queue-in
                       (current-buffer)))))))

(defun opencode-chat--drain-permission-queue-in (buffer)
  "Call `opencode-chat--drain-permission-queue' in BUFFER if live."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (opencode-chat--drain-permission-queue))))

(defun opencode-chat--enqueue-permission (parsed)
  "Queue a permission ask from PARSED JSONL alist and schedule UI."
  (let* ((id (alist-get "id" parsed nil nil #'string=))
         (permission (alist-get "permission" parsed nil nil #'string=))
         (title (alist-get "title" parsed nil nil #'string=))
         (patterns (alist-get "patterns" parsed nil nil #'string=))
         (stderr-buf (get-buffer-create "*opencode-chat-stderr*")))
    (if (not (and id (stringp id) (not (string-empty-p id))))
        (with-current-buffer stderr-buf
          (goto-char (point-max))
          (insert (format "[%s] permission event missing id: %S\n"
                          (format-time-string "%H:%M:%S")
                          parsed)))
      (with-current-buffer stderr-buf
        (goto-char (point-max))
        (insert (format "[%s] permission ask: %s (%s)\n"
                        (format-time-string "%H:%M:%S")
                        (or title permission "unknown")
                        id)))
      (setq opencode-chat--permission-queue
            (append opencode-chat--permission-queue
                    (list (list :id id
                                :permission permission
                                :title title
                                :patterns (and (vectorp patterns)
                                               (append patterns nil))))))
      (run-at-time 0 nil #'opencode-chat--drain-permission-queue-in
                   (current-buffer)))))

(defun opencode-chat--process-line (line stderr-buf)
  "Parse one JSON line from ocd --stream and apply it.
LINE is a complete JSON line (without trailing newline).
STDERR-BUF is the buffer for logging unknown event types and errors.
Must be called with the chat buffer current.

Handled types:
- `text' -- assistant chunk into the response region
- `session_id' -- persist OpenCode session id
- `permission' -- ask the user; reply via JSONL permission_reply
- other -- log to STDERR-BUF"
  (condition-case err
      (let* ((parsed (json-parse-string line :object-type 'alist))
             (type (alist-get "type" parsed nil nil #'string=)))
        (pcase type
          ("text"
           (let ((text (alist-get "text" parsed nil nil #'string=)))
             (when (and text (not (string-empty-p text)))
               (opencode-chat--insert-text text))))
          ("session_id"
           (let ((id (alist-get "id" parsed nil nil #'string=)))
             (setq opencode-chat--session-id id)
             ;; Persist promptly when a trailing Local Variables block
             ;; is intact.  Skip if the footer was corrupted — save-state
             ;; will rewrite it later.
             (when (and id buffer-file-name
                        (opencode-chat--local-variables-start))
               (save-excursion
                 (add-file-local-variable 'opencode-chat--session-id id)))))
          ("permission"
           (opencode-chat--enqueue-permission parsed))
          (_
           (with-current-buffer stderr-buf
             (goto-char (point-max))
             (insert (format "[%s] unknown event type: %S\n"
                             (format-time-string "%H:%M:%S")
                             parsed))))))
    (json-parse-error
     (with-current-buffer stderr-buf
       (goto-char (point-max))
       (insert (format "[%s] malformed JSON: %S\n"
                       (format-time-string "%H:%M:%S")
                       line))))
    (error
     (with-current-buffer stderr-buf
       (goto-char (point-max))
       (insert (format "[%s] process-line error: %S on %S\n"
                       (format-time-string "%H:%M:%S")
                       err line))))))

(defun opencode-chat--insert-response-chunk (start end text)
  "Insert TEXT between START and END, marking it as a response region.
When START equals END, inserts at point.  When START < END, deletes
the region first.  Sets the `opencode-response' text property (with
`front-sticky') on the inserted text and records the (BEG . END)
pair in the buffer-local `opencode-chat--bounds' alist for
persistence via file-local vars (todo 13).

If the new region is adjacent to or overlaps the last recorded
region in `opencode-chat--bounds', the last entry is extended
instead of creating a new one.  This handles the case where the
process filter calls `opencode-chat--insert-text' multiple times
for the same response (each chunk extends the region)."
  (let ((beg (min start end))
        (fin (max start end)))
    (when (/= beg fin)
      (delete-region beg fin))
    (goto-char beg)
    (insert text)
    (let ((new-end (point)))
      (set-text-properties beg new-end
                           '(opencode-response t
                             front-sticky (opencode-response)
                             ;; Keep follow-up typing from inheriting
                             ;; the assistant mark (Evil append / EOB).
                             rear-nonsticky (opencode-response)))
      ;; Record or extend bounds.  If the new region starts at or
      ;; before the end of the last recorded region, extend the last
      ;; entry.  Otherwise push a new entry.
      (let ((last (car (last opencode-chat--bounds))))
        (if (and (consp last) (numberp (cdr last)) (<= beg (cdr last)))
            ;; Adjacent or overlapping: extend the last entry.
            (setcdr last new-end)
          ;; New region: push a new entry.
          (setq opencode-chat--bounds
                (append opencode-chat--bounds
                        (list (cons beg new-end)))))))))

(defun opencode-chat--insert-text (text)
  "Insert TEXT as part of a response with the `opencode-response' property.
If the buffer is not currently inside a response region, this is the
first chunk of a new turn: move to the chat body end (before Local
Variables), ensure a blank line separator, then insert the text.
Subsequent chunks of the same turn are concatenated without separator.

Always keeps a newline between the response and the trailing
`;; Local Variables:' line so the footer is never prefixed."
  (let* ((lv (opencode-chat--local-variables-start))
         (in-response (and (> (point) (point-min))
                           (or (null lv) (< (point) lv))
                           (get-text-property (max (point-min) (1- (point)))
                                              'opencode-response)))
         (start-pos nil))
    (unless in-response
      (opencode-chat--goto-body-end)
      (unless (= (point) (point-min))
        (unless (eq (char-before) ?\n)
          (insert "\n"))
        (insert "\n"))
      (setq start-pos (point)))
    (when (null start-pos)
      (setq start-pos (point)))
    (opencode-chat--insert-response-chunk start-pos (point) text)
    ;; Keep Local Variables on its own line and leave an empty line for
    ;; the next user prompt.  Point is mid-line here, so no `^' anchor.
    (when (looking-at-p ";; Local Variables:")
      (insert "\n\n")
      (forward-char -1))))

(defun opencode-chat--process-sentinel (proc event)
  "Process sentinel for the `opencode-chat' subprocess.
Logs EVENT to the `*opencode-chat-stderr*' buffer and clears the
buffer-local `opencode-chat--process' when the subprocess finishes
or exits abnormally.  Does NOT kill the buffer or close Emacs."
  (let ((stderr-buf (get-buffer-create "*opencode-chat-stderr*"))
        (buf (process-buffer proc)))
    (with-current-buffer stderr-buf
      (goto-char (point-max))
      (insert (format "[%s] sentinel: %s\n"
                      (format-time-string "%H:%M:%S")
                      event)))
    (when (and (buffer-live-p buf)
               (or (string-match-p "finished" event)
                   (string-match-p "exited abnormally" event)))
      (with-current-buffer buf
        (setq opencode-chat--process nil)))))

;;; State persistence (todo 13).
;; File-local vars let `opencode-chat-mode' recover session state when
;; a session file is reopened.  `opencode-chat--save-state' writes the
;; vars via `add-file-local-variable' on save; `opencode-chat--restore-state'
;; reads them back on mode activation and reapplies text properties.

(defun opencode-chat--save-state (&optional _ignore)
  "Write opencode-chat file-local vars to the current buffer.
Installed on `write-file-functions' by `opencode-chat-mode'.  Uses
`add-file-local-variable' to append `;; var: value' lines to the
buffer's `Local Variables:' section, so the next `find-file' can
restore the session via `opencode-chat--restore-state'.

`opencode-chat--bounds' is recomputed from live `opencode-response'
text properties (not the possibly stale in-memory alist) so edits
earlier in the buffer do not persist wrong offsets.  Markers keep
those runs stable while the Local Variables block is rewritten.

The four vars persisted are:
- `opencode-chat--session-name' (string, always present for session files)
- `opencode-chat--session-id' (string or nil)
- `opencode-chat--bounds' (alist of (BEG . END) response region pairs)
- `opencode-chat--created' (timestamp string)

Returns nil so the save proceeds normally.  The `_ignore' argument
is the buffer position passed by `write-file-functions' (unused)."
  (when (and (boundp 'opencode-chat--session-name)
             opencode-chat--session-name)
    (let ((session-name opencode-chat--session-name)
          (session-id (and (boundp 'opencode-chat--session-id)
                           opencode-chat--session-id))
          (created (and (boundp 'opencode-chat--created)
                        opencode-chat--created))
          ;; Capture runs before Local Variables edits shift positions.
          (runs (opencode-chat--response-run-markers))
          bounds)
      ;; Drop legacy header Local Variables (and any stale copy) so the
      ;; canonical block lives at end-of-file where Emacs can find it.
      (opencode-chat--remove-local-variables-section)
      (setq bounds (mapcar (lambda (pair)
                             (cons (marker-position (car pair))
                                   (marker-position (cdr pair))))
                           runs)
            opencode-chat--bounds bounds)
      (add-file-local-variable 'opencode-chat--session-name session-name)
      (add-file-local-variable 'opencode-chat--session-id session-id)
      (add-file-local-variable 'opencode-chat--created created)
      (add-file-local-variable 'opencode-chat--bounds bounds)))
  ;; Return nil so `save-buffer' proceeds with the normal write.
  nil)

(defun opencode-chat--restore-bounds (bounds)
  "Apply `opencode-response' text property to regions in BOUNDS.
BOUNDS is a list of (BEG . END) pairs (as stored in the
`opencode-chat--bounds' file-local var).  For each pair, sets the
`opencode-response' property with `front-sticky' on the region.
Positions beyond the buffer end are truncated to (point-max);
positions before (point-min) are clamped to (point-min).  Pairs
with non-numeric or inverted bounds are skipped silently."
  (dolist (pair bounds)
    (when (consp pair)
      (let ((beg (car pair))
            (end (cdr pair)))
        (when (and (numberp beg) (numberp end)
                   (<= beg end))
          (setq beg (max beg (point-min))
                end (min end (point-max)))
          (when (< beg end)
            (set-text-properties beg end
                                 '(opencode-response t
                                   front-sticky (opencode-response)
                                   rear-nonsticky (opencode-response)))))))))

(defun opencode-chat--restore-state ()
  "Restore session state from file-local vars.
Called from `opencode-chat-mode-hook' (installed by
`opencode-chat-mode') when the buffer is file-backed and file-local
vars are present.  Reads `opencode-chat--session-name',
`opencode-chat--session-id', `opencode-chat--bounds', and
`opencode-chat--created' from `file-local-variables-alist', applies
text properties to the response regions recorded in
`opencode-chat--bounds', and starts the subprocess via
`opencode-chat--start-process'.

If `opencode-chat--bounds' is present but not a valid list, logs a
warning via `message' and starts a fresh session (bounds cleared,
subprocess still started if session-name is valid).  If no
file-local vars are present, does nothing (the buffer is treated as
a fresh, non-restored session)."
  (when (and buffer-file-name
             (boundp 'file-local-variables-alist)
             file-local-variables-alist
             (assq 'opencode-chat--session-name file-local-variables-alist))
    (let* ((alist file-local-variables-alist)
           (session-name (alist-get 'opencode-chat--session-name alist))
           (session-id (alist-get 'opencode-chat--session-id alist))
           (bounds-raw (alist-get 'opencode-chat--bounds alist))
           (created (alist-get 'opencode-chat--created alist))
           (bounds-present (assq 'opencode-chat--bounds alist)))
      ;; Set buffer-local vars from file-local values.
      (when (stringp session-name)
        (setq opencode-chat--session-name session-name))
      (when (or (null session-id) (stringp session-id))
        (setq opencode-chat--session-id session-id))
      (when (stringp created)
        (setq opencode-chat--created created))
      (cond
       ;; Bounds file-local var not present: nothing to restore.
       ((null bounds-present)
        nil)
       ;; Bounds present but corrupt (not a list): warning + fresh.
       ((not (listp bounds-raw))
        (message "opencode-chat: corrupt bounds in file-local vars, starting fresh session")
        (setq opencode-chat--bounds nil))
       ;; Valid bounds: restore text properties and spawn subprocess.
       (t
        (setq opencode-chat--bounds bounds-raw)
        (opencode-chat--restore-bounds bounds-raw)
        (condition-case err
            (opencode-chat--start-process)
          (error
           (message "opencode-chat: failed to start subprocess: %S" err))))))))

;;; Session helpers.
;; Internal functions used by `opencode-chat-open' (todo 11),
;; `opencode-chat-rename-session' (todo 14), and `opencode-chat-resume'
;; (todo 15).  None of these are user-facing, so they have no
;; `;;;###autoload' cookie.

(defun opencode-chat--ensure-sessions-dir ()
  "Return the expanded absolute path of `opencode-chat-sessions-dir'.
Creates the directory (and any missing parents) if it does not
already exist, using `make-directory' with a non-nil PARENTS flag.
Returns the path as a string."
  (let ((dir (expand-file-name opencode-chat-sessions-dir)))
    (unless (file-directory-p dir)
      (make-directory dir t))
    dir))

(defun opencode-chat--session-file-path (name)
  "Return the absolute file path for a session named NAME.
The path is `<opencode-chat-sessions-dir>/<name>.md'.  The sessions
directory is created if missing via `opencode-chat--ensure-sessions-dir'."
  (expand-file-name (concat name ".md")
                    (opencode-chat--ensure-sessions-dir)))

;;;###autoload
(defalias 'opencode-chat--session-file #'opencode-chat--session-file-path
  "Alias for `opencode-chat--session-file-path' (shorter name).")

(defun opencode-chat--generate-anonymous-name ()
  "Return a fresh anonymous session name of the form `anon-XXXXXXXX'.
The 8 hex characters are the first 8 chars of an MD5 digest of
`user-uid', `emacs-pid', and `float-time'.  If the corresponding
file already exists in `opencode-chat-sessions-dir', the name is
regenerated with a numeric suffix until a unique one is found.
At most 10 attempts are made; on exhaustion, the last candidate
is returned (callers should handle the rare collision)."
  (let ((dir (opencode-chat--ensure-sessions-dir))
        (attempts 0)
        name file)
    (while (and (< attempts 10)
                (or (null name) (file-exists-p file)))
      (let ((base (substring (secure-hash 'md5
                                          (format "%s%s%s"
                                                  (user-uid)
                                                  (emacs-pid)
                                                  (float-time)))
                             0 8)))
        (setq name (if (zerop attempts)
                       (concat "anon-" base)
                     (format "anon-%s-%d" base attempts)))
        (setq file (expand-file-name (concat name ".md") dir)))
      (setq attempts (1+ attempts)))
    name))

(defun opencode-chat--sanitize-name (name)
  "Return a filesystem-safe version of NAME.
Replaces any character not in `[a-zA-Z0-9._-]' with `_'."
  (replace-regexp-in-string "[^a-zA-Z0-9._-]" "_" name))

(defun opencode-chat--list-session-files ()
  "Return sorted session basenames (without `.md') in sessions dir.
Returns an empty list when the directory is empty or contains no
`.md' files.  Used by `opencode-chat-rename-session' for completion
and by `opencode-chat-resume' for session selection."
  (let ((dir (opencode-chat--ensure-sessions-dir)))
    (sort (mapcar #'file-name-base
                  (directory-files dir nil "\\.md\\'"))
          #'string<)))

(defun opencode-chat--wait-for-process-exit (proc timeout)
  "Wait up to TIMEOUT seconds for PROC to exit.
Returns t if the process exited (or was never live) within TIMEOUT,
nil otherwise.  Uses `accept-process-output' in a loop so pending
output is drained and the sentinel can fire."
  (when (and proc (process-live-p proc))
    (let ((deadline (+ (float-time) timeout))
          (ok nil))
      (while (and (process-live-p proc)
                  (< (float-time) deadline))
        (accept-process-output proc 0.1))
      (setq ok (not (process-live-p proc)))
      ok)))

;;; Open command (todo 11).
;; Reuses `opencode-chat--ensure-sessions-dir' from the Session
;; helpers section above (todo 12's spec was partially pre-implemented
;; in this file; we don't redefine it here).

(defun opencode-chat--generate-anon-name ()
  "Generate a unique anonymous session name like `anon-<8-hex-chars>'.
The hash input is `(user-uid) (emacs-pid) (float-time)' per todo 11's
spec; an internal counter is mixed in to avoid collisions when the
generated name already exists in `opencode-chat-sessions-dir'.
Retries up to 16 times before giving up (which should never happen
in practice)."
  (let ((dir (opencode-chat--ensure-sessions-dir))
        (counter 0)
        name)
    (while (and (< counter 16)
                (or (null name)
                    (file-exists-p
                     (expand-file-name (concat name ".md") dir))))
      (setq name (concat "anon-"
                         (substring
                          (secure-hash 'md5
                                       (format "%s%s%s%s"
                                               (user-uid)
                                               (emacs-pid)
                                               (float-time)
                                               counter))
                          0 8)))
      (setq counter (1+ counter)))
    (or name "anon-error")))

(defun opencode-chat--create-session-file (file name)
  "Write FILE with initial content and file-local vars for session NAME.
Chat body comes first; the `Local Variables' block is at end-of-file
so Emacs still finds it after the transcript grows past 3kB.
The `safe-local-variable' declarations at the bottom of this file
mark the vars as safe so Emacs does not prompt the user."
  (let ((created (format-time-string "%Y-%m-%dT%H:%M:%S%z")))
    (with-temp-buffer
      (insert (format "# OpenCode Chat Session: %s\n\n" name))
      (insert "Type your message and press `C-c C-c` to send.\n")
      ;; Blank line = empty editable body. Trailing Local Variables must
      ;; stay at EOB for `hack-local-variables' on long transcripts.
      (insert "\n")
      (insert ";; Local Variables:\n")
      (insert (format ";; opencode-chat--session-name: %S\n" name))
      (insert ";; opencode-chat--session-id: nil\n")
      (insert ";; opencode-chat--bounds: nil\n")
      (insert (format ";; opencode-chat--created: %S\n" created))
      (insert ";; End:\n")
      (write-region (point-min) (point-max) file nil 'no-message))))

;;;###autoload
(defun opencode-chat-open (&optional arg)
  "Open or create an OpenCode chat session buffer.
With a prefix argument \\[universal-argument], prompt for a session name
(resume existing or create new named session).
Without a prefix, generate a fresh anonymous session name of the form
`anon-<8-hex-chars>'.

When called non-interactively with a string ARG, use ARG as the
session name (for testing/programmatic use).

The buffer is backed by a real file under
`opencode-chat-sessions-dir' (default `~/.opencode-chat/sessions/').
Existing files are reopened and restored via file-local vars;
new files are created with file-local vars for future restoration."
  (interactive "P")
  (let* ((name (cond
                ;; Non-interactive call with explicit string arg.
                ((and (stringp arg) (not (string-empty-p arg))) arg)
                ;; Interactive with prefix: prompt for name.
                (arg
                 (let ((input (read-string
                               "Session name (resume or create new): "
                               nil nil "")))
                   (if (string-empty-p input)
                       (opencode-chat--generate-anon-name)
                     input)))
                ;; Interactive without prefix (or Lisp call with no arg):
                ;; generate anon name.
                (t
                 (opencode-chat--generate-anon-name))))
         (dir (opencode-chat--ensure-sessions-dir))
         (file (expand-file-name (concat name ".md") dir)))
    (if (file-exists-p file)
        (find-file file)
      (opencode-chat--create-session-file file name)
      (find-file file))
    ;; Set the session name buffer-local.  In interactive use, the
    ;; file-local vars written by `opencode-chat--create-session-file'
    ;; (or already present in resumed files) would set this via
    ;; `find-file' -> `hack-local-variables'; in batch mode that hook
    ;; is a no-op, so we set it explicitly.  The mode saves and
    ;; restores this value around the parent mode's
    ;; `kill-all-local-variables'.
    (setq opencode-chat--session-name name)
    ;; `opencode-chat-mode' should be auto-activated by `auto-mode-alist'
    ;; via `find-file' in interactive use, but call explicitly as a
    ;; safety net (e.g. when the test uses a custom sessions dir that
    ;; doesn't match the regex, or in batch mode where modes don't
    ;; auto-activate).  Wrap in `condition-case' so a failed subprocess
    ;; spawn (e.g. `ocd' not on PATH) doesn't tear down the buffer.
    (condition-case err
        (unless (derived-mode-p 'opencode-chat-mode)
          (opencode-chat-mode))
      (error
       (message "opencode-chat: mode activation failed: %S" err)))
    ;; Place point in the editable body (before the trailing Local
    ;; Variables block), ready for the first prompt.
    (goto-char (opencode-chat--body-beg))
    (current-buffer)))

;; Declare file-local vars as safe so Emacs does not prompt the user
;; on `find-file'.  Without these, every open of a session file would
;; show a "risky local variable" prompt.
;; `opencode-chat--bounds' is marked always-safe so `hack-local-variables'
;; populates the alist even for corrupt values; the restore function
;; validates the value and logs a warning for non-list bounds.
(put 'opencode-chat--session-name 'safe-local-variable #'stringp)
(put 'opencode-chat--session-id 'safe-local-variable
     (lambda (v) (or (null v) (stringp v))))
(put 'opencode-chat--bounds 'safe-local-variable #'always)
(put 'opencode-chat--created 'safe-local-variable #'stringp)

(provide 'opencode-chat)
;;; opencode-chat.el ends here
