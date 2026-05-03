from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any


_TYPE_MAP = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}
_BOOL_TRUE = {"true", "1", "yes", "y", "on"}
_BOOL_FALSE = {"false", "0", "no", "n", "off"}


def _cast_one(value: Any, schema: dict) -> Any:
    if value is None:
        return None
    t = schema.get("type")
    # type can be a list (nullable) — pick the first non-null
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        t = non_null[0] if non_null else None

    if t == "integer":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    if t == "number":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                return value
        return value

    if t == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            v = value.strip().lower()
            if v in _BOOL_TRUE:  return True
            if v in _BOOL_FALSE: return False
        return value

    if t == "array" and isinstance(value, list):
        item_schema = schema.get("items", {})
        return [_cast_one(v, item_schema) for v in value]

    if t == "object" and isinstance(value, dict):
        props = schema.get("properties", {})
        return {k: (_cast_one(v, props[k]) if k in props else v) for k, v in value.items()}

    return value


def _validate_one(value: Any, schema: dict, path: str = "") -> None:
    t = schema.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        if value is None and "null" in t:
            return
        t = non_null[0] if non_null else None

    if value is None and t is not None:
        raise ValueError(f"{path or 'value'}: must not be null")

    expected = _TYPE_MAP.get(t) if t else None
    if expected:
        if t == "integer" and isinstance(value, bool):
            raise ValueError(f"{path or 'value'}: expected integer, got bool")
        if t == "number" and isinstance(value, bool):
            raise ValueError(f"{path or 'value'}: expected number, got bool")
        if not isinstance(value, expected):
            raise ValueError(
                f"{path or 'value'}: expected {t}, got {type(value).__name__}"
            )

    if t == "string":
        if "enum" in schema and value not in schema["enum"]:
            raise ValueError(f"{path or 'value'}: must be one of {schema['enum']}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ValueError(f"{path or 'value'}: length >= {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValueError(f"{path or 'value'}: length <= {schema['maxLength']}")
    elif t in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            raise ValueError(f"{path or 'value'}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValueError(f"{path or 'value'}: must be <= {schema['maximum']}")
    elif t == "array":
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise ValueError(f"{path or 'value'}: must have >= {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ValueError(f"{path or 'value'}: must have <= {schema['maxItems']} items")
        item_schema = schema.get("items", {})
        for i, v in enumerate(value):
            _validate_one(v, item_schema, f"{path}[{i}]")
    elif t == "object":
        for k in schema.get("required", []):
            if k not in value:
                raise ValueError(f"{path or 'value'}: missing required field '{k}'")
        props = schema.get("properties", {})
        for k, v in value.items():
            if k in props:
                _validate_one(v, props[k], f"{path}.{k}" if path else k)


class Tool(ABC):
    read_only: bool = False
    exclusive: bool = False

    @property
    def concurrency_safe(self) -> bool:
        return self.read_only and not self.exclusive

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def description(self) -> str: ...

    @property
    @abstractmethod
    def parameters(self) -> dict: ...

    def cast_params(self, params: dict) -> dict:
        return _cast_one(params, self.parameters)

    def validate_params(self, params: dict) -> None:
        _validate_one(params, self.parameters)

    @abstractmethod
    def execute(self, **kwargs) -> str:
        ...


def tool_parameters(schema: dict):
    """Class decorator: freeze a JSON Schema dict onto a Tool subclass and
    expose it via the `parameters` property. Saves boilerplate.

    Usage:
        @tool_parameters(tool_parameters_schema(command=StringSchema(...)))
        class RunCommand(Tool): ...
    """
    def wrap(cls):
        cls._parameters_schema = schema
        cls.parameters = property(lambda self: type(self)._parameters_schema)
        if "parameters" in getattr(cls, "__abstractmethods__", set()):
            cls.__abstractmethods__ = frozenset(
                m for m in cls.__abstractmethods__ if m != "parameters"
            )
        return cls
    return wrap
