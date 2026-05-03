from __future__ import annotations
from typing import Any


class Schema:
    def to_json_schema(self) -> dict:
        raise NotImplementedError

    def validate_value(self, value: Any, path: str = "") -> None:
        raise NotImplementedError


def _check_nullable(value: Any, nullable: bool, path: str) -> bool:
    if value is None:
        if nullable:
            return True
        raise ValueError(f"{path or 'value'}: must not be null")
    return False


class StringSchema(Schema):
    def __init__(self, description: str, *, enum: list[str] | None = None,
                 min_length: int | None = None, max_length: int | None = None,
                 nullable: bool = False):
        self.description = description
        self.enum = enum
        self.min_length = min_length
        self.max_length = max_length
        self.nullable = nullable

    def to_json_schema(self) -> dict:
        s: dict = {"type": "string", "description": self.description}
        if self.enum is not None:       s["enum"] = self.enum
        if self.min_length is not None: s["minLength"] = self.min_length
        if self.max_length is not None: s["maxLength"] = self.max_length
        if self.nullable:               s["type"] = ["string", "null"]
        return s

    def validate_value(self, value: Any, path: str = "") -> None:
        if _check_nullable(value, self.nullable, path): return
        if not isinstance(value, str):
            raise ValueError(f"{path or 'value'}: expected string, got {type(value).__name__}")
        if self.enum is not None and value not in self.enum:
            raise ValueError(f"{path or 'value'}: must be one of {self.enum}")
        if self.min_length is not None and len(value) < self.min_length:
            raise ValueError(f"{path or 'value'}: length must be >= {self.min_length}")
        if self.max_length is not None and len(value) > self.max_length:
            raise ValueError(f"{path or 'value'}: length must be <= {self.max_length}")


class IntegerSchema(Schema):
    def __init__(self, description: str, *, minimum: int | None = None,
                 maximum: int | None = None, nullable: bool = False):
        self.description = description
        self.minimum = minimum
        self.maximum = maximum
        self.nullable = nullable

    def to_json_schema(self) -> dict:
        s: dict = {"type": "integer", "description": self.description}
        if self.minimum is not None: s["minimum"] = self.minimum
        if self.maximum is not None: s["maximum"] = self.maximum
        if self.nullable:            s["type"] = ["integer", "null"]
        return s

    def validate_value(self, value: Any, path: str = "") -> None:
        if _check_nullable(value, self.nullable, path): return
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{path or 'value'}: expected integer, got {type(value).__name__}")
        if self.minimum is not None and value < self.minimum:
            raise ValueError(f"{path or 'value'}: must be >= {self.minimum}")
        if self.maximum is not None and value > self.maximum:
            raise ValueError(f"{path or 'value'}: must be <= {self.maximum}")


class NumberSchema(Schema):
    def __init__(self, description: str, *, minimum: float | None = None,
                 maximum: float | None = None, nullable: bool = False):
        self.description = description
        self.minimum = minimum
        self.maximum = maximum
        self.nullable = nullable

    def to_json_schema(self) -> dict:
        s: dict = {"type": "number", "description": self.description}
        if self.minimum is not None: s["minimum"] = self.minimum
        if self.maximum is not None: s["maximum"] = self.maximum
        if self.nullable:            s["type"] = ["number", "null"]
        return s

    def validate_value(self, value: Any, path: str = "") -> None:
        if _check_nullable(value, self.nullable, path): return
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{path or 'value'}: expected number, got {type(value).__name__}")
        if self.minimum is not None and value < self.minimum:
            raise ValueError(f"{path or 'value'}: must be >= {self.minimum}")
        if self.maximum is not None and value > self.maximum:
            raise ValueError(f"{path or 'value'}: must be <= {self.maximum}")


class BooleanSchema(Schema):
    def __init__(self, description: str, *, nullable: bool = False):
        self.description = description
        self.nullable = nullable

    def to_json_schema(self) -> dict:
        s: dict = {"type": "boolean", "description": self.description}
        if self.nullable: s["type"] = ["boolean", "null"]
        return s

    def validate_value(self, value: Any, path: str = "") -> None:
        if _check_nullable(value, self.nullable, path): return
        if not isinstance(value, bool):
            raise ValueError(f"{path or 'value'}: expected boolean, got {type(value).__name__}")


class ArraySchema(Schema):
    def __init__(self, description: str, items: Schema, *,
                 min_items: int | None = None, max_items: int | None = None):
        self.description = description
        self.items = items
        self.min_items = min_items
        self.max_items = max_items

    def to_json_schema(self) -> dict:
        s: dict = {"type": "array", "description": self.description,
                   "items": self.items.to_json_schema()}
        if self.min_items is not None: s["minItems"] = self.min_items
        if self.max_items is not None: s["maxItems"] = self.max_items
        return s

    def validate_value(self, value: Any, path: str = "") -> None:
        if not isinstance(value, list):
            raise ValueError(f"{path or 'value'}: expected array, got {type(value).__name__}")
        if self.min_items is not None and len(value) < self.min_items:
            raise ValueError(f"{path or 'value'}: must have >= {self.min_items} items")
        if self.max_items is not None and len(value) > self.max_items:
            raise ValueError(f"{path or 'value'}: must have <= {self.max_items} items")
        for i, v in enumerate(value):
            self.items.validate_value(v, f"{path}[{i}]")


class ObjectSchema(Schema):
    def __init__(self, description: str, properties: dict[str, Schema],
                 required: list[str] | None = None):
        self.description = description
        self.properties = properties
        self.required = required or []

    def to_json_schema(self) -> dict:
        return {
            "type": "object",
            "description": self.description,
            "properties": {k: v.to_json_schema() for k, v in self.properties.items()},
            "required": self.required,
        }

    def validate_value(self, value: Any, path: str = "") -> None:
        if not isinstance(value, dict):
            raise ValueError(f"{path or 'value'}: expected object, got {type(value).__name__}")
        for k in self.required:
            if k not in value:
                raise ValueError(f"{path or 'value'}: missing required field '{k}'")
        for k, v in value.items():
            if k in self.properties:
                self.properties[k].validate_value(v, f"{path}.{k}" if path else k)


def tool_parameters_schema(**fields: Schema) -> dict:
    """Helper: build an object-shaped JSON Schema from Schema fields.

    Required fields are inferred (all fields are required by default; use
    nullable=True on the Schema if a field may be absent semantically).
    """
    return {
        "type": "object",
        "properties": {k: v.to_json_schema() for k, v in fields.items()},
        "required": list(fields.keys()),
    }
