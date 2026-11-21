import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { seedInitialData } from './db/database'

seedInitialData().then(() => {
  createApp(App).mount('#app')
})
