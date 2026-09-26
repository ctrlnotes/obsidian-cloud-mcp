// Two small modals the settings pane opens: a confirmation, and the list behind a skipped-
// file count.
//
// **Dismissal is a refusal**, for the reason `adopt.ts`'s modal gives: Escape, the X and a
// click outside all reach `onClose` and nothing else, so `onClose` resolves `false` unless a
// button already answered. A promise left unsettled there would leave the pane waiting for
// ever on a question nobody can see any more.
//
// **Cancel is added first and nothing takes focus from it**, so the default focus — the
// button Enter presses — is the one that changes nothing. The confirming button carries
// `setDestructive()` when what it does cannot be undone from this device.
//
// **A named gap, the same one `adopt.ts` declares**: layout and focus on a real host are
// checked by manual acceptance. The tests hold which strings are shown and what each exit
// resolves to.

import { type App, Modal, Setting } from "obsidian";
import { type SkippedFile, skipReasonText } from "./sync/status.ts";

export interface ConfirmCopy {
  readonly title: string;
  readonly body: readonly string[];
  readonly confirmText: string;
  readonly cancelText: string;
  /** Style the confirming button as destructive (`setDestructive`, which replaced
   * `setWarning` in Obsidian 1.13). */
  readonly destructive: boolean;
}

class ConfirmModal extends Modal {
  #answered = false;

  constructor(
    app: App,
    private readonly copy: ConfirmCopy,
    private readonly settle: (yes: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.copy.title);
    for (const line of this.copy.body) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(this.copy.cancelText).onClick(() => this.answer(false)),
      )
      .addButton((button) => {
        button.setButtonText(this.copy.confirmText).onClick(() => this.answer(true));
        if (this.copy.destructive) button.setDestructive();
      });
  }

  override onClose(): void {
    this.answer(false);
  }

  private answer(yes: boolean): void {
    if (this.#answered) return;
    this.#answered = true;
    this.settle(yes);
    this.close();
  }
}

/** Open a confirmation and resolve with the answer. Never rejects. */
export const askToConfirm = (app: App, copy: ConfirmCopy): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    new ConfirmModal(app, copy, resolve).open();
  });

/** The files behind the pane's counts, each with its reason. Read only: nothing here acts. */
class SkippedFilesModal extends Modal {
  constructor(
    app: App,
    private readonly files: readonly SkippedFile[],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Files that are not syncing");
    const list = this.contentEl.createEl("ul");
    for (const file of this.files) {
      const item = list.createEl("li");
      item.createEl("code", { text: file.path });
      item.createDiv({ text: skipReasonText(file), cls: "setting-item-description" });
    }
  }
}

export const showSkippedFiles = (app: App, files: readonly SkippedFile[]): void => {
  new SkippedFilesModal(app, files).open();
};
