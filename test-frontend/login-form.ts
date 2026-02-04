/**
 * User Registration Form
 * Frontend component for user registration
 */

interface RegisterFormData {
  email: string;
  password: string;
  name: string;
}

class RegistrationForm {
  private formElement: HTMLFormElement;

  constructor(formId: string) {
    this.formElement = document.getElementById(formId) as HTMLFormElement;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.formElement.addEventListener('submit', this.handleSubmit.bind(this));
  }

  private async handleSubmit(event: Event) {
    event.preventDefault();

    const formData = this.getFormData();

    try {
      // Call backend registration API
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          name: formData.name,
        }),
      });

      if (!response.ok) {
        throw new Error('Registration failed');
      }

      const result = await response.json();

      // Handle successful registration
      console.log('Registration successful:', result);
      // Expected response: { userId, token, email }

      // Store token and redirect
      localStorage.setItem('authToken', result.token);
      window.location.href = '/dashboard';
    } catch (error) {
      console.error('Registration error:', error);
      alert('Registration failed. Please try again.');
    }
  }

  private getFormData(): RegisterFormData {
    const formData = new FormData(this.formElement);

    return {
      email: formData.get('email') as string,
      password: formData.get('password') as string,
      name: formData.get('name') as string,
    };
  }
}

export default RegistrationForm;
