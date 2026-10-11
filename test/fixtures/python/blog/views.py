from django.views import View

from .models import Article


def article_list(request):
    return Article.objects.all()


class ArticleDetail(View):
    def get(self, request, pk):
        article = Article.objects.get(pk=pk)
        article.publish()
        return article
