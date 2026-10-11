class Base:
    def save(self):
        return self


class User(Base):
    def __init__(self, name: str):
        self.name = name

    def touch(self):
        super().save()

    @property
    def display(self) -> str:
        return self.name.title()
