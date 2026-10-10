class NotifyJob < ApplicationJob
  def perform(id)
    Post.recent
    Post.find(id).view!
  end
end
