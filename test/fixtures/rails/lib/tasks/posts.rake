namespace :posts do
  task cleanup: :environment do
    Post.published.each(&:view!)
  end
end
