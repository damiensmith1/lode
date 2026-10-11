class PostsController < ApplicationController
  def index
    @posts = Post.published
  end

  def show
    @post = Post.find(params[:id])
    @post.view!
  end

  def mine
    current_user.posts.published.each { |post| post.view! }
    current_user.posts.first.view!
  end

  def headline
    Comment.new.headline
  end

  def publish
    @post = Post.find(params[:id])
    @post.publish!
    NotifyJob.perform_later(@post.id)
    PostMailer.published(@post).deliver_later
  end
end
