class PostMailer < ApplicationMailer
  def published(post)
    mail(to: post.author)
  end
end
