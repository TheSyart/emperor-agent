from __future__ import annotations

from pathlib import Path

import pytest

from agent.skill_requests import (
    SkillRequestError,
    build_requested_skills_block,
    inject_requested_skills,
    parse_requested_skills,
)
from agent.skills import SkillsLoader


def write_skill(root: Path, name: str, description: str = "test skill") -> None:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nUse it carefully.\n",
        encoding="utf-8",
    )


def test_parse_requested_skills_validates_and_deduplicates_names() -> None:
    names = parse_requested_skills(
        [
            {"name": "web-design-engineer", "source": "slash"},
            {"name": "WEB-DESIGN-ENGINEER", "source": "slash"},
        ],
        {"web-design-engineer"},
    )

    assert names == ["web-design-engineer"]


def test_parse_requested_skills_rejects_unknown_or_bad_source() -> None:
    with pytest.raises(SkillRequestError):
        parse_requested_skills([{"name": "missing", "source": "slash"}], {"known"})

    with pytest.raises(SkillRequestError):
        parse_requested_skills([{"name": "known", "source": "manual"}], {"known"})


def test_build_block_and_inject_into_text(tmp_path: Path) -> None:
    write_skill(tmp_path, "summarize")
    loader = SkillsLoader(tmp_path)

    block = build_requested_skills_block(loader, ["summarize"])
    injected = inject_requested_skills("整理这段文字", block)

    assert "<requested_skills>" in block
    assert '<skill name="summarize">' in block
    assert "<user_task>" in injected
    assert "整理这段文字" in injected


def test_inject_into_multimodal_content_preserves_image_blocks(tmp_path: Path) -> None:
    write_skill(tmp_path, "vision-helper")
    loader = SkillsLoader(tmp_path)
    block = build_requested_skills_block(loader, ["vision-helper"])
    content = [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]

    injected = inject_requested_skills(content, block)

    assert injected[0]["type"] == "text"
    assert "vision-helper" in injected[0]["text"]
    assert injected[1]["type"] == "image_url"
