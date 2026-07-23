# Bug Log

## 2026-07-23 - Speaker fallback generated fake daily task names and long cards failed Feishu limits

### Symptom

After rerunning the 2026-07-23 meeting document, a self-reported task from `简学勤` still appeared as `简学勤今日工作确认` instead of a concrete task name. Another assignee, `洪伟填`, did not receive a card because Feishu rejected the interactive card with `ErrCode: 11310; ErrMsg: element exceeds the limit`.

### Expected Behavior

- If a speaker says their own today task, the system must preserve/generate a concrete task from the spoken action, for example `继续收尾 AI 智能会议助手的工具应用，测试后接入总表`.
- The system must never generate formal task names like `<负责人>今日工作确认`, `<负责人>今日工作生成`, or `<负责人>今日工作`.
- Feishu cards must display bounded text so a long task description, evidence quote, matched task name, or progress summary cannot make the entire card fail to send.
- Truncation must apply only to Feishu card display defaults, not erase the full draft data stored for later processing.

### Root Cause

`speakerCoverageTaskItems()` tried to avoid missing a reliable speaker, but used a hardcoded fallback title:

```js
task_name: `${speaker}今日工作确认`
```

That fallback ran after the normal task filter, so it bypassed the existing `assignee_only_daily_task_name` guard and reintroduced the exact generic title the filter was designed to reject.

The card delivery failure came from `inputElement()` in `feishuTaskCardPure.js`. It copied `default_value: String(value || '')` into Feishu card input elements without bounding length. Long `task_name`, `matched_task_name`, or `progress_summary` values could therefore exceed Feishu's per-element card limits and fail the whole assignee card.

### Fix Requirements

- Derive speaker-coverage fallback titles from the speaker segment text by removing only leading self-report framing such as `我今天的任务就是`.
- Keep the concrete action/object text and never produce `<speaker>今日工作确认`.
- Bound Feishu input default values centrally in `inputElement()`.
- Add regressions for concrete self-reported fallback titles and long card input defaults.

### Regression Tests

`server/scripts/test-feishu-task-cards.js` includes:

- `testSelfReportedTodayTaskCreatesConcreteFallbackTaskName()`
- strengthened `testMissingDailySpeakerGetsFallbackConfirmationCardItem()` and `testReliableSpeakerGetsEditableChoiceCardWithoutTodayKeyword()`
- `testTaskCardInputDefaultsAreBoundedForLongDraftContent()`

## 2026-07-23 - Failed card stayed editable but final confirm ignored explicit new-task choice

### Symptom

After an old-task confirmation failed with `不能填写原表格没有的任务`, the refreshed card became editable again. The user then clicked `标记为新任务` and clicked final confirm, but the card still behaved like a failed old-task confirmation and appeared to have no response.

### Expected Behavior

- `标记为新任务` and `标记为旧任务进展` are explicit user routing choices.
- Final confirm must respect an explicit stored `task_choice='new_task'` even if the old-task textbox still contains a stale value from an earlier failed attempt.
- Final confirm should only infer old-task intent from a non-empty old-task textbox when the user has not explicitly selected `new_task`.
- Confirmation failure cards must remain editable so the user can correct the task name or switch choice and retry.

### Root Cause

`confirmAssigneeTasks()` rebuilt pending tasks from current form values and called `taskChoiceFromCurrentForm()`. That helper treated any submitted non-empty `matched_task_name_<item_id>` as old-task intent before considering whether the stored card state had already been explicitly switched back to `new_task`.

Because failed old-task cards preserve the old-task textbox value, switching the card to `new_task` did not matter: the next final confirm saw the stale old-task name and forced the item back into `old_task_progress`, causing the same old-task validation failure again.

### Fix Requirements

- In `taskChoiceFromCurrentForm()`, return `new_task` first when the stored task choice is explicitly `new_task`.
- Preserve the direct-final-confirm convenience path: if no explicit new-task choice exists and the current form contains a non-empty old-task name, infer `old_task_progress`.
- Add a regression where `task_choice='new_task'` plus a stale invalid `matched_task_name` still confirms through the new-task path and does not call progress finalization.

### Regression Test

`server/scripts/test-feishu-task-cards.js` includes `testFinalConfirmHonorsExplicitNewChoiceOverOldTaskNameInput()`:

- stored draft task has `task_choice='new_task'`
- form submission still includes `matched_task_name_explicit_new_1='不存在的旧任务名'`
- mocked `masterTaskNameExists()` returns false
- final confirm must still return `你的选择已确认`
- new-task finalizer must run, progress finalizer must not run

## 2026-07-22 - Feishu task card old-task textbox confirmed as new task

### Symptom

In `draft_id=35`, a user received a task card where the old-task textbox was blank, entered `111` in `对应旧任务名称`, then clicked final confirm. The card did not show `不能填写原表格没有的任务`. Instead, confirmation succeeded and the master table received a new task named `简学勤今日工作生成`.

### Expected Behavior

- If the user fills `对应旧任务名称`, final confirmation must treat that item as an old-task-progress intent.
- The submitted old task name must be checked against the master task table by exact task-name match before any draft mutation or master-table write.
- If the name is absent from the master table, reject with exactly `不能填写原表格没有的任务`.
- Do not create a new task from the generated `任务名称` field in this case.

### Root Cause

Earlier fixes validated the `标记为旧任务进展` button path and the already-stored `task_choice='old_task_progress'` final-confirm path, but missed the direct final-confirm path where the user edits the old-task textbox without first clicking the old-task button.

In that path, `confirmAssigneeTasks()` used the stored `task_choice` from the draft. Because the stored choice was still the default new-task choice, the item was routed to `finalizeAssignee()` and written as a new task using `task_name`, while the user's current `matched_task_name` value was ignored for classification.

### Fix Requirements

- During final confirm, build pending tasks from current form values first.
- If current form values include a non-empty `matched_task_name_<item_id>`, classify that item as `old_task_progress` even when stored `task_choice` was not updated earlier.
- Prevalidate all old-progress tasks against the master table before updating draft task statuses or writing any records.
- Keep invalid old-task submissions in pending state after rejection.

### Regression Test

`server/scripts/test-feishu-task-cards.js` includes `testFinalConfirmInfersOldProgressFromOldTaskNameInput()`:

- draft task name is `简学勤今日工作生成`
- submitted old-task textbox is `111`
- mocked master table has no matching records
- final confirm must reject with `不能填写原表格没有的任务`
- create-record call count must stay `0`
- draft task status must remain `pending`

## 2026-07-22 - Draft 36 task card flow still confusing and incomplete

### Production Report

After deploying `d6c2bd5` and rerunning the 7月22 Wiki docx, the new draft was `draft_id=36`. A user tested the newly delivered Feishu card and reported four failures:

1. The generated task name was still semantically wrong. Example: `简学勤今日工作确认` / similar generated text did not match the meeting transcript content.
2. The old-task textbox was blank. The card did not output a proposed old-task match from the master table.
3. Clicking the `新任务` and `旧任务进展` buttons did not visibly turn the selected option blue, so the user could not tell whether the click was accepted.
4. After clicking final confirm, there was no follow-up feedback. This time even a confirmation-success message was not visible.

### Expected Behavior

- Task names must be grounded in the transcript action item, not generated from assignee name plus generic words like `今日工作确认`.
- Old-task suggestions must be produced only by first reading the master task table names, then comparing the meeting item against those names. If there is no real match, the old-task textbox can stay blank, but the system must not pretend the generated task name is a historical match.
- Selecting `新任务` or `旧任务进展` must visibly update card state, including button styling or a clear selected-state marker.
- Final confirm must return clear user feedback for success, rejection, or background-processing failure. Silent/no-feedback confirm is a product bug.

### Suspected Causes To Verify

- AI extraction or speaker-coverage fallback is still fabricating generic fallback task names for speakers instead of deriving tasks strictly from transcript statements.
- Old-task matching may now be too conservative or not wired to master-table candidates during card generation, leaving all old-task suggestion fields blank.
- Card update after `mark_task_as_new` / `mark_task_as_progress` may not change visual button styles enough, or Feishu card update may be failing silently after the quick ACK.
- The quick-ACK callback returns `正在处理`, while downstream background errors may only be stored in logs or draft state and not surfaced back to the user card.

### Fix Requirements

- Add tests or diagnostics that show the exact generated card items for `draft_id=36`, including source transcript quote, task name, old-task match source, and fallback reason.
- Refuse or flag fallback task names that are merely `<assignee>今日工作...` unless a transcript quote supports that action.
- During card generation, compare against exact master-table task names and record why each old-task textbox is blank or prefilled.
- Update card visual state so the selected choice is unambiguous after a button click.
- Ensure final confirm produces visible Feishu feedback on both success and failure, and stores `confirmation_error` when background processing fails.
