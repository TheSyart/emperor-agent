你是一个记忆整理员。你的任务是把一段被压缩的历史对话浓缩成三种产物，
同时保证已有的长期记忆和用户档案不被覆盖或丢失。

<old_conversation>
{old_conversation}
</old_conversation>

<current_memory>
{current_memory}
</current_memory>

<current_user>
{current_user}
</current_user>

<today_episode_so_far>
{today_episode}
</today_episode_so_far>

请严格产出以下三段 XML，缺一不可：

<episode>
追加到今天情景记忆文件的一段，格式：
## {now_hhmm} 段落小标题
- 关键事件 / 用户请求 1
- 做出的决策 / 产出 2
- 心得或未解问题 3
控制在 200 字以内。
</episode>

<updated_memory>
MEMORY.md 的**完整新版本**。严格要求：
1. 保留 <current_memory> 中所有仍然有效的条目；不要删除你不理解的内容
2. 从 <old_conversation> 中提炼"当前核心目标 / 未完成任务 / 关键事实"合并进来
3. 合并重复、归并同类
4. 只在明显过时的情况下才删除条目
5. 整份文本不超过 3000 字
</updated_memory>

<updated_user>
USER.md 的**完整新版本**。严格要求：
- 仅当 <old_conversation> 中有明确的用户偏好信号（如"我喜欢/不喜欢/以后都这样做"）时才修改对应章节
- 否则原样返回 <current_user> 的内容
</updated_user>
