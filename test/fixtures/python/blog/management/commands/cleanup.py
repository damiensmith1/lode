from django.core.management.base import BaseCommand

from blog.models import Article


class Command(BaseCommand):
    def handle(self, *args, **options):
        for article in Article.objects.filter(draft=True):
            article.publish()
