from fastapi import APIRouter, Depends

from ..services import UserService, get_service

router = APIRouter(prefix="/users")


@router.get("/{user_id}")
def read_user(user_id: int, service: UserService = Depends(get_service)):
    return service.find(user_id)


@router.post("/")
def create_user(name: str):
    service = UserService.build()
    return service.register(name)
