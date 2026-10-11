from celery import shared_task


@shared_task
def send_welcome(name: str):
    return f"welcome {name}"
