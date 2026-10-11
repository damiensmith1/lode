from django.urls import include, path

urlpatterns = [
    path("blog/", include("blog.urls")),
    path("shop/", include("shop.urls")),
]
