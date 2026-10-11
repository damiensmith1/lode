from abc import ABC, abstractmethod


class Judge(ABC):
    @abstractmethod
    def ask(self, question: str) -> str: ...


class JevJudge(Judge):
    def ask(self, question: str) -> str:
        return "jev"


class FakeJudge(Judge):
    def ask(self, question: str) -> str:
        return "fake"


def judge_all(judge: Judge) -> str:
    return judge.ask("x")
