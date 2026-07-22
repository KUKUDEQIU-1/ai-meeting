# Bug Log

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
