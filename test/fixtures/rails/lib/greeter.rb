class Greeter
  def initialize(name)
    @name = name
  end

  def greet
    format_name
  end

  def self.build
    new("x")
  end

  private

  def format_name
    @name.upcase
  end
end
