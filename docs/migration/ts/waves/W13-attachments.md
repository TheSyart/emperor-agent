# W13 · 附件 / 多模态（ATT）

依赖：W03　|　子系统映射：`agent/attachments.py`。

### MIG-ATT-001 · AttachmentStore（落盘 + MIME 校验）

- **功能点**：上传落盘、MIME 校验、安全文件名、路径布局。
- **源(Python)**：`agent/attachments.py`（`AttachmentStore`、`AttachmentRef`、`_safe_name`/`_ext_from_name`/`_mime_from_ext`、`ALLOWED_*_MIMES`）。
- **目标(TS)**：`packages/core/src/attachments/store.ts`。
- **依赖**：MIG-FND-002
- **设计**：落盘 `memory/attachments/YYYY-MM/{hash8}-{name}.{ext}`；MIME/大小白名单。**磁盘兼容**：路径布局不变。
- **风险/复杂度**：S。
- **验证**：移植附件落盘/MIME 单测。**验收**：路径/校验一致。
- **状态**：todo · PR: —

### MIG-ATT-002 · 文本/PDF 抽取 sidecar

- **功能点**：文档抽取 sidecar `*.txt`，拼进用户消息，附落盘路径。
- **源(Python)**：`agent/attachments.py`（`_extract_pdf_text`、sidecar 逻辑）。
- **目标(TS)**：`packages/core/src/attachments/extract.ts`（`pdf-parse`/`unpdf`，**选型记风险**）。
- **依赖**：MIG-ATT-001
- **设计**：尽可能抽取 sidecar 文本；抽取文本拼进消息，结尾附路径给 read_file 兜底。**风险**：PDF 抽取库口径与 Python 不同，黄金样本对账。
- **风险/复杂度**：M。
- **验证**：用同一批 PDF/文本做黄金样本对账；移植抽取单测。**验收**：抽取结果容差内一致。
- **状态**：todo · PR: —

### MIG-ATT-003 · 图片多模态编码

- **功能点**：支持视觉的 entry 走 image_url block；不支持转提示文本。
- **源(Python)**：`agent/attachments.py`（`encode_for_openai_block`、`ref_to_json`）。
- **目标(TS)**：`packages/core/src/attachments/encode.ts`。
- **依赖**：MIG-ATT-001、MIG-PROV-001
- **设计**：图片 base64→OpenAI `image_url` data block / Anthropic image block；无视觉→提示文本不丢消息。
- **风险/复杂度**：S。
- **验证**：移植多模态编码单测。**验收**：视觉/降级路径一致。
- **状态**：todo · PR: —
